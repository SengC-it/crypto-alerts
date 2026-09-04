// Point-in-time public derivatives features for bounded M1.2 research.
// This module is deliberately separate from the live/production signal path.

export const M12_FEATURE_VERSION = 'm1.2-pit-derivatives-0.1.1';

export const M12_DERIVATIVE_FAMILIES = Object.freeze([
  'Funding',
  'Open Interest',
  'Basis/Premium',
  'Taker Flow',
]);

export const M12_REPRESENTATIVE_FEATURES = Object.freeze({
  Funding: 'funding_rate',
  'Open Interest': 'price_oi_divergence_4h',
  'Basis/Premium': 'premium',
  'Taker Flow': 'taker_imbalance',
});

export const M12_MAX_STALE_MS = Object.freeze({
  Funding: 12 * 60 * 60 * 1000,
  'Open Interest': 2 * 60 * 60 * 1000,
  'Basis/Premium': 2 * 60 * 60 * 1000,
  'Taker Flow': 60 * 60 * 1000 + 1,
});

export const M12_MIN_COVERAGE = 0.98;
export const LIQUIDATION_DATA_NOT_ADMITTED = 'LIQUIDATION_DATA_NOT_ADMITTED';
export const NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK =
  'NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK';

const HOUR = 60 * 60 * 1000;

function finite(value) {
  return value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
}

function timestampValue(value) {
  const numeric = finite(value);
  if (numeric !== null) return numeric;
  const text = String(value || '');
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function sourceTimestamp(row) {
  return timestampValue(row?.source_timestamp
    ?? row?.timestamp
    ?? row?.close_time
    ?? row?.open_time
    ?? row?.calc_time
    ?? row?.create_time);
}

function availabilityTimestamp(row) {
  return timestampValue(row?.availability_timestamp
    ?? row?.available_at
    ?? sourceTimestamp(row));
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function sortSeries(series = []) {
  const byTimestamp = new Map();
  for (const row of series || []) {
    const timestamp = sourceTimestamp(row);
    if (timestamp === null) continue;
    byTimestamp.set(timestamp, {
      ...row,
      source_timestamp: timestamp,
      availability_timestamp: availabilityTimestamp(row),
    });
  }
  return [...byTimestamp.values()].sort((left, right) => left.source_timestamp - right.source_timestamp);
}

function latestAt(series = [], asOfTimestamp) {
  const asOf = timestampValue(asOfTimestamp);
  if (asOf === null || !series.length) return null;
  let low = 0;
  let high = series.length - 1;
  let found = -1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (series[middle].source_timestamp <= asOf) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found < 0 ? null : series[found];
}

function nextAfter(series = [], asOfTimestamp) {
  const asOf = timestampValue(asOfTimestamp);
  if (asOf === null) return null;
  return series.find(row => row.source_timestamp > asOf) || null;
}

function pointInTimeLookup(series = [], asOfTimestamp, maxStaleMs) {
  const asOf = timestampValue(asOfTimestamp);
  if (asOf === null) {
    return { point_in_time_valid: false, invalid_reason: 'invalid_as_of_timestamp' };
  }
  const row = latestAt(series, asOf);
  if (!row) {
    return {
      point_in_time_valid: false,
      invalid_reason: nextAfter(series, asOf) ? 'future_only_observation' : 'no_prior_observation',
    };
  }
  const source = row.source_timestamp;
  const availability = row.availability_timestamp;
  if (source > asOf) {
    return { point_in_time_valid: false, invalid_reason: 'future_source_timestamp' };
  }
  if (availability === null) {
    return { point_in_time_valid: false, invalid_reason: 'missing_availability_timestamp' };
  }
  if (availability > asOf) {
    return {
      source_timestamp: source,
      availability_timestamp: availability,
      point_in_time_valid: false,
      invalid_reason: 'future_availability_timestamp',
    };
  }
  const staleAge = asOf - availability;
  if (staleAge < 0) {
    return {
      source_timestamp: source,
      availability_timestamp: availability,
      point_in_time_valid: false,
      invalid_reason: 'negative_stale_age',
    };
  }
  if (staleAge > maxStaleMs) {
    return {
      source_timestamp: source,
      availability_timestamp: availability,
      stale_age_ms: staleAge,
      point_in_time_valid: false,
      invalid_reason: 'stale_data',
    };
  }
  return {
    row,
    source_timestamp: source,
    availability_timestamp: availability,
    stale_age_ms: staleAge,
    point_in_time_valid: true,
    invalid_reason: null,
  };
}

function seriesBySymbol(input = {}, { candle = false } = {}) {
  return Object.fromEntries(Object.entries(input || {}).map(([symbol, rows]) => {
    const prepared = (rows || []).map(row => {
      if (!candle) return row;
      const timestamp = timestampValue(row?.close_time ?? row?.timestamp ?? row?.open_time);
      return {
        ...row,
        source_timestamp: timestamp,
        availability_timestamp: timestamp,
      };
    });
    return [symbol.toUpperCase(), sortSeries(prepared)];
  }));
}

export function buildPointInTimeFeatureIndex({
  fundingBySymbol = {},
  openInterestBySymbol = {},
  premiumBySymbol = {},
  candlesBySymbol = {},
} = {}) {
  return {
    funding: seriesBySymbol(fundingBySymbol),
    openInterest: seriesBySymbol(openInterestBySymbol),
    premium: seriesBySymbol(premiumBySymbol),
    candles: seriesBySymbol(candlesBySymbol, { candle: true }),
  };
}

function previousValue(series, timestamp, field) {
  const row = latestAt(series, timestampValue(timestamp) - 1);
  return row ? finite(row[field]) : null;
}

function percentChange(current, previous) {
  if (current === null || previous === null || previous === 0) return null;
  return round((current - previous) / Math.abs(previous) * 100, 8);
}

function sign(value) {
  return value === null ? null : value === 0 ? 0 : value > 0 ? 1 : -1;
}

function candlePriceAt(candles, timestamp) {
  const row = latestAt(candles, timestamp);
  return row ? finite(row.close) : null;
}

function buildFundingFeature(symbol, asOf, index) {
  const lookup = pointInTimeLookup(index.funding[symbol] || [], asOf, M12_MAX_STALE_MS.Funding);
  const rate = finite(lookup.row?.funding_rate ?? lookup.row?.last_funding_rate);
  if (!lookup.point_in_time_valid || rate === null) {
    return {
      family: 'Funding',
      feature_version: M12_FEATURE_VERSION,
      ...lookup,
      representative_value: null,
    };
  }
  const series = index.funding[symbol] || [];
  const previousRate = previousValue(series, lookup.source_timestamp, 'funding_rate')
    ?? previousValue(series, lookup.source_timestamp, 'last_funding_rate');
  const previousRow = latestAt(series, lookup.source_timestamp - 1);
  const previousPreviousRate = previousRow
    ? previousValue(series, previousRow.source_timestamp, 'funding_rate')
      ?? previousValue(series, previousRow.source_timestamp, 'last_funding_rate')
    : null;
  const change = previousRate === null ? null : round(rate - previousRate, 12);
  const previousChange = previousRate === null || previousPreviousRate === null
    ? null
    : round(previousRate - previousPreviousRate, 12);
  return {
    family: 'Funding',
    feature_version: M12_FEATURE_VERSION,
    ...lookup,
    funding_rate: rate,
    funding_direction: sign(rate),
    funding_change: change,
    funding_acceleration: change === null || previousChange === null ? null : round(change - previousChange, 12),
    time_since_funding_event_ms: Math.max(0, Number(asOf) - lookup.source_timestamp),
    funding_interval_hours: finite(lookup.row?.funding_interval_hours),
    representative_feature: M12_REPRESENTATIVE_FEATURES.Funding,
    representative_value: rate,
  };
}

function buildOpenInterestFeature(symbol, asOf, index) {
  const lookup = pointInTimeLookup(index.openInterest[symbol] || [], asOf, M12_MAX_STALE_MS['Open Interest']);
  const currentOi = finite(lookup.row?.open_interest ?? lookup.row?.sum_open_interest);
  const candles = index.candles[symbol] || [];
  const currentPrice = candlePriceAt(candles, asOf);
  if (!lookup.point_in_time_valid || currentOi === null || currentPrice === null) {
    return {
      family: 'Open Interest',
      feature_version: M12_FEATURE_VERSION,
      ...lookup,
      representative_value: null,
      invalid_reason: lookup.invalid_reason || 'missing_open_interest_or_price',
    };
  }
  const series = index.openInterest[symbol] || [];
  const oiAt = hours => {
    const row = latestAt(series, lookup.source_timestamp - hours * HOUR);
    return row ? finite(row.open_interest ?? row.sum_open_interest) : null;
  };
  const priceAt = hours => candlePriceAt(candles, Number(asOf) - hours * HOUR);
  const oiChange1h = percentChange(currentOi, oiAt(1));
  const oiChange4h = percentChange(currentOi, oiAt(4));
  const oiChange24h = percentChange(currentOi, oiAt(24));
  const priceChange1h = percentChange(currentPrice, priceAt(1));
  const priceChange4h = percentChange(currentPrice, priceAt(4));
  const priceChange24h = percentChange(currentPrice, priceAt(24));
  const divergence = oiChange4h === null || priceChange4h === null
    ? null
    : round(oiChange4h - priceChange4h, 8);
  const priceSign = sign(priceChange4h);
  const oiSign = sign(oiChange4h);
  const quadrant = priceSign > 0 && oiSign > 0
    ? 'price_up_oi_up'
    : priceSign > 0 && oiSign < 0
      ? 'price_up_oi_down'
      : priceSign < 0 && oiSign > 0
        ? 'price_down_oi_up'
        : priceSign < 0 && oiSign < 0
          ? 'price_down_oi_down'
          : 'flat_or_missing';
  if (divergence === null) {
    return {
      family: 'Open Interest',
      feature_version: M12_FEATURE_VERSION,
      ...lookup,
      current_open_interest: currentOi,
      representative_value: null,
      invalid_reason: 'missing_4h_price_oi_divergence',
    };
  }
  return {
    family: 'Open Interest',
    feature_version: M12_FEATURE_VERSION,
    ...lookup,
    current_open_interest: currentOi,
    open_interest_value: finite(lookup.row?.open_interest_value ?? lookup.row?.sum_open_interest_value),
    oi_change_1h_percent: oiChange1h,
    oi_change_4h_percent: oiChange4h,
    oi_change_24h_percent: oiChange24h,
    price_change_1h_percent: priceChange1h,
    price_change_4h_percent: priceChange4h,
    price_change_24h_percent: priceChange24h,
    price_oi_divergence_4h: divergence,
    positioning_quadrant: quadrant,
    representative_feature: M12_REPRESENTATIVE_FEATURES['Open Interest'],
    representative_value: divergence,
  };
}

function buildPremiumFeature(symbol, asOf, index) {
  const lookup = pointInTimeLookup(index.premium[symbol] || [], asOf, M12_MAX_STALE_MS['Basis/Premium']);
  const premium = finite(lookup.row?.premium ?? lookup.row?.close);
  if (!lookup.point_in_time_valid || premium === null) {
    return {
      family: 'Basis/Premium',
      feature_version: M12_FEATURE_VERSION,
      ...lookup,
      representative_value: null,
      invalid_reason: lookup.invalid_reason || 'missing_premium',
    };
  }
  const series = index.premium[symbol] || [];
  const previous = hours => {
    const row = latestAt(series, lookup.source_timestamp - hours * HOUR);
    return row ? finite(row.premium ?? row.close) : null;
  };
  return {
    family: 'Basis/Premium',
    feature_version: M12_FEATURE_VERSION,
    ...lookup,
    premium,
    premium_direction: sign(premium),
    premium_change_1h: percentChange(premium, previous(1)),
    premium_change_4h: percentChange(premium, previous(4)),
    premium_change_24h: percentChange(premium, previous(24)),
    representative_feature: M12_REPRESENTATIVE_FEATURES['Basis/Premium'],
    representative_value: premium,
  };
}

function takerValues(row) {
  const volume = finite(row?.volume);
  const buy = finite(row?.taker_buy_volume ?? row?.taker_buy_base_volume);
  const quote = finite(row?.quote_volume ?? row?.quote_asset_volume);
  if (volume === null || buy === null || quote === null || volume <= 0 || buy < 0 || buy > volume) return null;
  const sell = volume - buy;
  return {
    volume,
    taker_buy_volume: buy,
    taker_sell_volume: sell,
    quote_volume: quote,
    taker_buy_ratio: buy / volume,
    taker_imbalance: (buy - sell) / volume,
  };
}

function buildTakerFeature(symbol, asOf, index) {
  const lookup = pointInTimeLookup(index.candles[symbol] || [], asOf, M12_MAX_STALE_MS['Taker Flow']);
  const values = takerValues(lookup.row);
  if (!lookup.point_in_time_valid || !values) {
    return {
      family: 'Taker Flow',
      feature_version: M12_FEATURE_VERSION,
      ...lookup,
      representative_value: null,
      invalid_reason: lookup.invalid_reason || 'missing_taker_volume_fields',
    };
  }
  const candles = index.candles[symbol] || [];
  const previous = latestAt(candles, lookup.source_timestamp - 1);
  const previousTaker = takerValues(previous);
  const previousQuotes = candles
    .filter(candle => candle.source_timestamp < lookup.source_timestamp)
    .slice(-24)
    .map(candle => finite(candle.row?.quote_volume ?? candle.quote_volume))
    .filter(value => value !== null);
  const averagePreviousQuote = previousQuotes.length
    ? previousQuotes.reduce((sum, value) => sum + value, 0) / previousQuotes.length
    : null;
  return {
    family: 'Taker Flow',
    feature_version: M12_FEATURE_VERSION,
    ...lookup,
    ...values,
    imbalance_change: previousTaker ? round(values.taker_imbalance - previousTaker.taker_imbalance, 8) : null,
    relative_participation: averagePreviousQuote && averagePreviousQuote > 0
      ? round(values.quote_volume / averagePreviousQuote, 8)
      : null,
    representative_feature: M12_REPRESENTATIVE_FEATURES['Taker Flow'],
    representative_value: round(values.taker_imbalance, 12),
  };
}

/**
 * Attach only observations available at each signal timestamp. Invalid or
 * stale families never receive a future substitute.
 */
export function attachPointInTimeDerivativeFeatures(records = [], datasets = {}, options = {}) {
  const index = datasets.funding && datasets.candles
    ? datasets
    : buildPointInTimeFeatureIndex(datasets);
  const featureVersion = options.featureVersion || M12_FEATURE_VERSION;
  return records.map(record => {
    const symbol = String(record.symbol || '').toUpperCase();
    const asOfTimestamp = timestampValue(record.timestamp
      ?? record.trigger_time
      ?? record.signal_timestamp);
    const derivatives = {
      Funding: buildFundingFeature(symbol, asOfTimestamp, index),
      'Open Interest': buildOpenInterestFeature(symbol, asOfTimestamp, index),
      'Basis/Premium': buildPremiumFeature(symbol, asOfTimestamp, index),
      'Taker Flow': buildTakerFeature(symbol, asOfTimestamp, index),
    };
    const invalidFamilies = M12_DERIVATIVE_FAMILIES.filter(family => (
      derivatives[family].point_in_time_valid !== true
      || finite(derivatives[family].representative_value) === null
    ));
    return {
      ...record,
      derivatives,
      derivative_feature_version: featureVersion,
      derivative_point_in_time_valid: invalidFamilies.length === 0,
      derivative_invalid_families: invalidFamilies,
    };
  });
}

export function getDerivativeFamilyValue(sample, family) {
  const feature = sample?.derivatives?.[family];
  if (feature?.point_in_time_valid !== true) return null;
  return finite(feature.representative_value);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function outcomeValue(sample) {
  return finite(sample?.primary_outcome)
    ?? finite(sample?.outcome)
    ?? finite(sample?.net_forward_returns?.['1h']);
}

function quantileGrid(values, size = 21) {
  return Array.from({ length: size }, (_, index) => {
    const probability = index / (size - 1);
    return [probability, round(quantile(values, probability), 12)];
  });
}

function percentileFromGrid(grid, value) {
  if (!grid?.length || value === null) return null;
  if (value <= grid[0][1]) return 0;
  if (value >= grid.at(-1)[1]) return 1;
  for (let index = 1; index < grid.length; index += 1) {
    const [probability, upper] = grid[index];
    const lowerProbability = grid[index - 1][0];
    const lower = grid[index - 1][1];
    if (value <= upper) {
      const span = upper - lower;
      return span === 0
        ? probability
        : lowerProbability + (probability - lowerProbability) * (value - lower) / span;
    }
  }
  return 1;
}

function primaryCorrelation(values, mean, standardDeviation) {
  const pairs = values.map(item => {
    const outcome = outcomeValue(item.sample);
    if (outcome === null) return null;
    const z = standardDeviation > 0 ? (item.value - mean) / standardDeviation : 0;
    return { z, outcome };
  }).filter(Boolean);
  if (!pairs.length) return null;
  const scale = average(pairs.map(pair => Math.abs(pair.outcome))) || 1;
  return average(pairs.map(pair => pair.z * pair.outcome / scale));
}

export function fitDerivativeFamilyPolicy(trainSamples = [], family, {
  minimumSamples = 30,
} = {}) {
  const values = trainSamples.map(sample => ({
    sample,
    value: getDerivativeFamilyValue(sample, family),
  })).filter(item => item.value !== null);
  const numericValues = values.map(item => item.value);
  const mean = average(numericValues);
  const variance = mean === null
    ? null
    : average(numericValues.map(value => (value - mean) ** 2));
  const standardDeviation = variance === null ? null : Math.sqrt(variance);
  const correlation = mean === null || standardDeviation === null
    ? null
    : primaryCorrelation(values, mean, standardDeviation);
  const signValue = correlation === null || correlation === 0 ? 0 : correlation > 0 ? 1 : -1;
  return {
    family,
    version: M12_FEATURE_VERSION,
    training_only: true,
    fitted: values.length >= minimumSamples,
    insufficient_training_samples: values.length < minimumSamples,
    minimum_training_samples: minimumSamples,
    representative_feature: M12_REPRESENTATIVE_FEATURES[family] || null,
    training_value_count: values.length,
    mean: round(mean, 12),
    standard_deviation: round(standardDeviation, 12),
    effective_standard_deviation: round(standardDeviation > 0 ? standardDeviation : 1, 12),
    quantile_grid: quantileGrid(numericValues),
    training_percentiles: {
      p10: round(quantile(numericValues, 0.1), 12),
      p50: round(quantile(numericValues, 0.5), 12),
      p90: round(quantile(numericValues, 0.9), 12),
    },
    sign: signValue,
    sign_fit_statistic: round(correlation, 12),
    sign_basis: 'train_primary_outcome_times_train_standardized_feature',
  };
}

export function fitDerivativePolicies(trainSamples = [], families = M12_DERIVATIVE_FAMILIES, options = {}) {
  const selected = [...new Set(families)].filter(family => M12_DERIVATIVE_FAMILIES.includes(family));
  return {
    version: M12_FEATURE_VERSION,
    training_only: true,
    families: selected,
    one_representative_contribution_per_family: true,
    policies: Object.fromEntries(selected.map(family => [
      family,
      fitDerivativeFamilyPolicy(trainSamples, family, options),
    ])),
  };
}

export function applyDerivativePolicies(sample, policy = {}) {
  const families = policy.families || [];
  const scores = {};
  const normalized = {};
  const invalidFamilies = [];
  for (const family of families) {
    const familyPolicy = policy.policies?.[family];
    const value = getDerivativeFamilyValue(sample, family);
    if (!familyPolicy?.fitted || value === null || familyPolicy.mean === null) {
      invalidFamilies.push(family);
      normalized[family] = {
        family,
        valid: false,
        value,
        reason: !familyPolicy?.fitted ? 'family_policy_not_fitted' : 'point_in_time_feature_invalid',
      };
      continue;
    }
    const scale = familyPolicy.effective_standard_deviation || 1;
    const zscore = (value - familyPolicy.mean) / scale;
    const percentile = percentileFromGrid(familyPolicy.quantile_grid, value);
    const signedZscore = zscore * (familyPolicy.sign || 0);
    scores[family] = round(50 + Math.tanh(signedZscore / 2) * 50, 8);
    normalized[family] = {
      family,
      valid: true,
      value: round(value, 12),
      zscore: round(zscore, 12),
      percentile: round(percentile, 12),
      signed_zscore: round(signedZscore, 12),
      score: scores[family],
      training_only_scaler: true,
    };
  }
  return {
    scores,
    normalized,
    invalid_families: invalidFamilies,
    all_valid: invalidFamilies.length === 0,
  };
}

function reportCoverage({
  family,
  field,
  symbol,
  startTime,
  endTime,
  series,
  stepMs,
  maxStaleMs,
  valueAccessor,
  source,
  timestampSemantics,
  forwardFillPolicy,
  coverageThreshold = M12_MIN_COVERAGE,
}) {
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  const bounded = sortSeries(series).filter(row => row.source_timestamp >= start && row.source_timestamp <= end);
  const expected = Math.max(0, Math.floor((end - start) / stepMs) + 1);
  const loaded = new Set(bounded
    .filter(row => finite(valueAccessor(row)) !== null)
    .map(row => row.source_timestamp)).size;
  const missing = Math.max(0, expected - loaded);
  const coverage = expected ? loaded / expected : 0;
  return {
    family,
    source,
    field,
    symbol,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    expected_observations: expected,
    loaded_observations: loaded,
    missing_observations: missing,
    coverage_percent: round(coverage * 100, 4),
    timestamp_semantics: timestampSemantics,
    publication_availability_lag: 'exchange-time availability; archive delivery lag excluded from signal timestamp',
    point_in_time_safe: bounded.every(row => (
      row.source_timestamp <= end
      && row.availability_timestamp !== null
      && row.availability_timestamp >= row.source_timestamp
    )),
    forward_fill_policy: forwardFillPolicy,
    maximum_stale_duration_ms: maxStaleMs,
    status: coverage >= coverageThreshold ? 'PASS' : 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY',
  };
}

function gridCoverage({
  family,
  field,
  symbol,
  startTime,
  endTime,
  series,
  maxStaleMs,
  source,
  timestampSemantics,
  forwardFillPolicy,
  coverageThreshold = M12_MIN_COVERAGE,
}) {
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  let expected = 0;
  let loaded = 0;
  for (let timestamp = start + HOUR - 1; timestamp <= end; timestamp += HOUR) {
    expected += 1;
    if (pointInTimeLookup(sortSeries(series), timestamp, maxStaleMs).point_in_time_valid) loaded += 1;
  }
  const coverage = expected ? loaded / expected : 0;
  return {
    family,
    source,
    field,
    symbol,
    start: new Date(start).toISOString(),
    end: new Date(end).toISOString(),
    expected_observations: expected,
    loaded_observations: loaded,
    missing_observations: expected - loaded,
    coverage_percent: round(coverage * 100, 4),
    timestamp_semantics: timestampSemantics,
    publication_availability_lag: 'exchange-time availability; archive delivery lag excluded from signal timestamp',
    point_in_time_safe: true,
    forward_fill_policy: forwardFillPolicy,
    maximum_stale_duration_ms: maxStaleMs,
    status: coverage >= coverageThreshold ? 'PASS' : 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY',
  };
}

/** Build the required per-source admission report without admitting proxies. */
export function buildDataAdmissionReport({
  symbols = [],
  startTime,
  endTime,
  datasets = {},
  candlesBySymbol = datasets.candlesBySymbol || {},
  source = 'public_binance_futures_archive',
  coverageThreshold = M12_MIN_COVERAGE,
} = {}) {
  const index = datasets.funding && datasets.candles
    ? datasets
    : buildPointInTimeFeatureIndex({
      fundingBySymbol: datasets.fundingBySymbol || {},
      openInterestBySymbol: datasets.openInterestBySymbol || {},
      premiumBySymbol: datasets.premiumBySymbol || {},
      candlesBySymbol,
    });
  const reports = [];
  for (const symbolValue of symbols) {
    const symbol = String(symbolValue).toUpperCase();
    reports.push(reportCoverage({
      family: 'Funding',
      field: 'funding_rate',
      symbol,
      startTime,
      endTime,
      series: index.funding[symbol] || [],
      stepMs: 8 * HOUR,
      maxStaleMs: M12_MAX_STALE_MS.Funding,
      valueAccessor: row => row.funding_rate ?? row.last_funding_rate,
      source: `${source}/fundingRate/monthly`,
      timestampSemantics: 'calc_time is the funding settlement observation time',
      forwardFillPolicy: 'last funding observation <= as_of, only while stale_age_ms <= 12h',
      coverageThreshold,
    }));
    reports.push(reportCoverage({
      family: 'Basis/Premium',
      field: 'premium',
      symbol,
      startTime,
      endTime,
      series: index.premium[symbol] || [],
      stepMs: HOUR,
      maxStaleMs: M12_MAX_STALE_MS['Basis/Premium'],
      valueAccessor: row => row.premium ?? row.close,
      source: `${source}/premiumIndexKlines/monthly/1h`,
      timestampSemantics: 'premium kline close_time is the completed hourly observation',
      forwardFillPolicy: 'last premium observation <= as_of, only while stale_age_ms <= 2h',
      coverageThreshold,
    }));
    reports.push(gridCoverage({
      family: 'Open Interest',
      field: 'sum_open_interest',
      symbol,
      startTime,
      endTime,
      series: index.openInterest[symbol] || [],
      maxStaleMs: M12_MAX_STALE_MS['Open Interest'],
      source: `${source}/metrics/daily`,
      timestampSemantics: 'create_time is the public metrics observation time; no future row is used',
      forwardFillPolicy: 'last OI observation <= as_of, only while stale_age_ms <= 2h; otherwise invalid',
      coverageThreshold,
    }));
    reports.push(reportCoverage({
      family: 'Taker Flow',
      field: 'taker_buy_volume/taker_sell_volume',
      symbol,
      startTime,
      endTime,
      series: index.candles[symbol] || [],
      stepMs: HOUR,
      maxStaleMs: M12_MAX_STALE_MS['Taker Flow'],
      valueAccessor: row => {
        const values = takerValues(row);
        return values ? values.taker_imbalance : null;
      },
      source: `${source}/klines/1h`,
      timestampSemantics: 'completed futures kline close_time; taker split is from the same public kline row',
      forwardFillPolicy: 'same timestamp completed kline only; no forward fill',
      coverageThreshold,
    }));
  }
  const familyReports = Object.fromEntries(M12_DERIVATIVE_FAMILIES.map(family => {
    const familyRows = reports.filter(report => report.family === family);
    const admitted = familyRows.length === symbols.length
      && familyRows.every(report => (
        report.point_in_time_safe === true
        && report.coverage_percent / 100 >= coverageThreshold
        && report.status === 'PASS'
      ));
    return [family, {
      family,
      admitted,
      status: admitted ? 'PASS' : 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY',
      coverage_threshold_percent: coverageThreshold * 100,
      fields: familyRows,
    }];
  }));
  return {
    version: M12_FEATURE_VERSION,
    source,
    requested_symbols: [...symbols].map(symbol => String(symbol).toUpperCase()).sort(),
    requested_start: new Date(timestampValue(startTime)).toISOString(),
    requested_end: new Date(timestampValue(endTime)).toISOString(),
    coverage_threshold_percent: coverageThreshold * 100,
    common_support_required: true,
    families: familyReports,
    records: reports,
    admitted_families: M12_DERIVATIVE_FAMILIES.filter(family => familyReports[family].admitted),
    rejected_families: M12_DERIVATIVE_FAMILIES.filter(family => !familyReports[family].admitted),
    liquidation: {
      admitted: false,
      status: LIQUIDATION_DATA_NOT_ADMITTED,
      reason: 'No reliable point-in-time liquidation archive was admitted in this bounded run.',
    },
    orderbook: {
      admitted: false,
      status: NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK,
      reason: 'No historical order-book snapshots were used or backfilled from current depth.',
    },
  };
}

export { latestAt, pointInTimeLookup, sortSeries };

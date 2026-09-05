// M1.3 cross-sectional / relative-value research.  This module is deliberately
// isolated from the production signal path: it only consumes closed public
// candles (and optional point-in-time research derivatives) and returns
// research records for a purged walk-forward evaluation.

import { hashConfig } from '../lineage.js';
import { filterClosedCandles } from '../market/candle.js';
import { buildResearchBarriers, RESEARCH_BARRIER_VERSION } from './barriers.js';
import { buildScoreCalibration } from './scoring.js';
import { runPurgedWalkForward } from './walkForward.js';

const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;

export const M13_MODEL_VERSION = 'm1.3-v2-cross-sectional-alpha-0.1.1';
export const M13_FEATURE_VERSION = 'm1.3-cross-sectional-0.1.1';
export const M13_CANDIDATE_BUDGET = 12;
export const M13_BOOTSTRAP_REPETITIONS = 2000;
export const M13_BOOTSTRAP_SEED = 20260904;
export const M13_MIN_VALID_SYMBOLS = 12;
export const M13_BETA_WINDOW_HOURS = 168;
export const M13_MIN_BETA_OBSERVATIONS = 120;
export const M13_HORIZONS_HOURS = Object.freeze([1, 4, 8, 12, 24, 48]);
export const M13_PRIMARY_HORIZONS = Object.freeze({
  relative_momentum: 8,
  residual_momentum: 8,
  residual_reversal: 4,
  breadth_momentum: 8,
  dispersion_momentum: 8,
  dispersion_reversal: 4,
  lead_lag: 4,
  relative_participation: 8,
});
export const M13_INDEPENDENT_EVENT_DEFINITION = 'fixed_utc_4h_bucket_from_candle_open_time';
export const M13_SNAPSHOT_EVENT_DEFINITION = 'exact_closed_1h_candle_close_timestamp';
export const M13_ROUND_TRIP_COST_PERCENT = 0.14;
export const M13_COST_SENSITIVITY_PERCENT = Object.freeze([0.10, 0.14, 0.20]);
export const M13_SAFETY_FLAGS = Object.freeze({
  V1_UNCHANGED: true,
  V2_PRODUCTION_ENABLED: false,
  V2_SHADOW_ONLY: true,
  AUTO_TRADING: false,
  M2_STARTED: false,
});
export const M13_PROMOTION_THRESHOLDS = Object.freeze({
  minimum_independent_events: 100,
  minimum_delta_net_expectancy_percent: 0,
  minimum_delta_ci_lower_percent: 0,
  minimum_probability_delta_gt_zero: 0.95,
  minimum_positive_window_ratio_vs_baseline: 1,
  maximum_symbol_event_share: 0.30,
  absolute_net_profit_factor: 1.25,
  absolute_net_expectancy_percent: 0.15,
  absolute_windows: 6,
  absolute_positive_windows: 4,
  absolute_positive_window_ratio: 2 / 3,
  absolute_symbol_breadth: 8,
});

export const M13_PREDECLARED_CANDIDATES = Object.freeze([
  Object.freeze({ candidate_id: 'X0-frozen-m1.1-candle-baseline', family: 'frozen_candle_baseline', source: 'm1.1', independent_generator: false, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X1-relative-momentum', family: 'relative_momentum', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X2-residual-momentum', family: 'residual_momentum', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X3-residual-mean-reversion', family: 'residual_reversal', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 4 }),
  Object.freeze({ candidate_id: 'X4-breadth-conditioned-relative-momentum', family: 'breadth_momentum', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X5-breadth-conditioned-residual-momentum', family: 'breadth_residual_momentum', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X6-dispersion-conditioned-momentum', family: 'dispersion_momentum', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X7-dispersion-conditioned-reversal', family: 'dispersion_reversal', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 4 }),
  Object.freeze({ candidate_id: 'X8-btc-eth-lead-lag-continuation', family: 'lead_lag_continuation', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 4 }),
  Object.freeze({ candidate_id: 'X9-btc-eth-lead-lag-reversal', family: 'lead_lag_reversal', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 4 }),
  Object.freeze({ candidate_id: 'X10-relative-participation-residual-momentum', family: 'relative_participation', source: 'cross_sectional', independent_generator: true, primary_horizon_hours: 8 }),
  Object.freeze({ candidate_id: 'X11-derivative-rank-residual-momentum', family: 'derivative_rank_residual_momentum', source: 'cross_sectional_derivatives', independent_generator: true, primary_horizon_hours: 8, requires_derivative_admission: true }),
]);

const CANDIDATE_BY_ID = new Map(M13_PREDECLARED_CANDIDATES.map(candidate => [candidate.candidate_id, candidate]));

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function average(values) {
  const valid = values.map(finite).filter(value => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function standardDeviation(values, meanValue = average(values)) {
  const valid = values.map(finite).filter(value => value !== null);
  if (!valid.length || meanValue === null) return null;
  const variance = valid.reduce((sum, value) => sum + (value - meanValue) ** 2, 0) / valid.length;
  return Math.sqrt(variance);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function tanhScore(value, scale = 1) {
  const numeric = finite(value);
  if (numeric === null) return null;
  return round(50 + Math.tanh(numeric / scale) * 50, 8);
}

function timestampValue(value) {
  const numeric = finite(value);
  if (numeric !== null) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function symbolName(value) {
  return String(value || '').toUpperCase();
}

function directionName(value) {
  const direction = String(value || '').toUpperCase();
  return direction === 'SELL' ? 'SELL' : 'BUY';
}

function candleCloseTime(candle) {
  return timestampValue(candle?.close_time ?? candle?.timestamp ?? candle?.open_time);
}

function candleOpenTime(candle) {
  return timestampValue(candle?.open_time)
    ?? (candleCloseTime(candle) === null ? null : candleCloseTime(candle) - HOUR + 1);
}

function snapshotEventId(timestamp) {
  return `m13-snapshot:${timestamp}`;
}

export function independentMarketEventId(openTime) {
  const value = timestampValue(openTime);
  return value === null ? null : `m13-4h:${Math.floor(value / FOUR_HOURS) * FOUR_HOURS}`;
}

function candleParticipation(candle) {
  const quote = finite(candle?.quote_volume ?? candle?.quoteVolume);
  if (quote !== null && quote > 0) return quote;
  const volume = finite(candle?.volume);
  const close = finite(candle?.close);
  return volume !== null && close !== null && volume > 0 && close > 0 ? volume * close : null;
}

function normalizedSeries(candles, symbol, endTime = Number.POSITIVE_INFINITY) {
  return filterClosedCandles(candles || [], {
    symbol,
    timeframe: '1h',
    now: endTime,
  }).filter(candle => {
    const closeTime = candleCloseTime(candle);
    return closeTime !== null && closeTime <= endTime && finite(candle.close) !== null;
  });
}

/**
 * Make one exact-timestamp cross-sectional snapshot.  A snapshot is admitted
 * only when at least the configured breadth is present; no symbol is carried
 * forward and no partially aligned timestamp is silently filled.
 */
export function buildCrossSectionSnapshots({
  candlesBySymbol = {},
  symbols = Object.keys(candlesBySymbol),
  startTime = null,
  endTime = Number.POSITIVE_INFINITY,
  minValidSymbols = M13_MIN_VALID_SYMBOLS,
} = {}) {
  const selectedSymbols = [...new Set((symbols || []).map(symbolName).filter(Boolean))].sort();
  const seriesBySymbol = Object.fromEntries(selectedSymbols.map(symbol => [
    symbol,
    normalizedSeries(candlesBySymbol[symbol] || candlesBySymbol[symbol.toLowerCase()] || [], symbol, endTime),
  ]));
  const byTimestamp = new Map();
  for (const symbol of selectedSymbols) {
    for (const [candleIndex, candle] of seriesBySymbol[symbol].entries()) {
      const timestamp = candleCloseTime(candle);
      if (startTime !== null && timestamp < Number(startTime)) continue;
      if (endTime !== null && timestamp > Number(endTime)) continue;
      if (!byTimestamp.has(timestamp)) byTimestamp.set(timestamp, new Map());
      byTimestamp.get(timestamp).set(symbol, {
        ...candle,
        symbol,
        candle_index: candleIndex,
        close_time: timestamp,
        open_time: candleOpenTime(candle),
      });
    }
  }
  const snapshots = [];
  const rejectedSnapshots = [];
  for (const timestamp of [...byTimestamp.keys()].sort((left, right) => left - right)) {
    const rows = byTimestamp.get(timestamp);
    const validSymbols = [...rows.keys()].sort();
    const first = rows.get(validSymbols[0]);
    const snapshot = {
      timestamp,
      snapshot_event_id: snapshotEventId(timestamp),
      independent_market_event_id: independentMarketEventId(first?.open_time),
      open_time: first?.open_time ?? null,
      valid_symbols: validSymbols,
      valid_symbol_count: validSymbols.length,
      candles: Object.fromEntries(validSymbols.map(symbol => [symbol, rows.get(symbol)])),
    };
    if (validSymbols.length < minValidSymbols) {
      rejectedSnapshots.push({
        ...snapshot,
        rejection_reason: 'INSUFFICIENT_CROSS_SECTION_BREADTH',
        minimum_valid_symbols: minValidSymbols,
      });
    } else {
      snapshots.push(snapshot);
    }
  }
  return {
    feature_version: M13_FEATURE_VERSION,
    symbols: selectedSymbols,
    snapshots,
    rejected_snapshots: rejectedSnapshots,
    snapshot_count: snapshots.length,
    rejected_snapshot_count: rejectedSnapshots.length,
    min_valid_symbols: minValidSymbols,
    timestamp_definition: M13_SNAPSHOT_EVENT_DEFINITION,
    independent_event_definition: M13_INDEPENDENT_EVENT_DEFINITION,
    closed_candles_only: true,
    no_forward_fill: true,
  };
}

/** Normalize a same-timestamp cross-section with deterministic symbol ties. */
export function crossSectionNormalize(values = []) {
  const entries = Array.isArray(values)
    ? values.map((item, index) => ({
      symbol: symbolName(item?.symbol ?? item?.key ?? index),
      value: finite(item?.value ?? item?.raw_value ?? item),
    }))
    : Object.entries(values || {}).map(([symbol, value]) => ({ symbol: symbolName(symbol), value: finite(value) }));
  const valid = entries.filter(item => item.value !== null)
    .sort((left, right) => right.value - left.value || left.symbol.localeCompare(right.symbol));
  const meanValue = average(valid.map(item => item.value));
  const deviation = standardDeviation(valid.map(item => item.value), meanValue);
  const resultBySymbol = new Map();
  valid.forEach((item, index) => {
    const rank = index + 1;
    const percentile = valid.length <= 1 ? 0.5 : (valid.length - rank) / (valid.length - 1);
    resultBySymbol.set(item.symbol, {
      symbol: item.symbol,
      value: item.value,
      rank,
      percentile: round(percentile, 12),
      zscore: round(deviation && deviation > 0 ? (item.value - meanValue) / deviation : 0, 12),
      valid: true,
    });
  });
  return entries.map(item => resultBySymbol.get(item.symbol) || {
    symbol: item.symbol,
    value: item.value,
    rank: null,
    percentile: null,
    zscore: null,
    valid: false,
  });
}

function exactPreviousRow(rowByTimestamp, timestamp, hours = 1) {
  return rowByTimestamp.get(timestamp - hours * HOUR) || null;
}

function returnFromRows(rowByTimestamp, timestamp, hours = 1) {
  const current = rowByTimestamp.get(timestamp);
  const previous = rowByTimestamp.get(timestamp - hours * HOUR);
  const currentClose = finite(current?.close);
  const previousClose = finite(previous?.close);
  if (currentClose === null || previousClose === null || previousClose === 0) return null;
  return currentClose / previousClose - 1;
}

function returnAt(rowByTimestamp, timestamp) {
  return returnFromRows(rowByTimestamp, timestamp, 1);
}

function cumulativeReturn(rowByTimestamp, timestamp, hours) {
  return returnFromRows(rowByTimestamp, timestamp, hours);
}

function currentMarketReturn(snapshot, snapshotsByTimestamp, symbol = null) {
  const values = [];
  for (const candidate of snapshot.valid_symbols) {
    if (candidate === symbol) continue;
    const value = returnAt(snapshotsByTimestamp.get(candidate) || new Map(), snapshot.timestamp);
    if (value !== null) values.push(value);
  }
  return average(values);
}

function marketCumulativeReturn(snapshot, snapshotsByTimestamp, hours, symbol = null) {
  const values = [];
  for (const candidate of snapshot.valid_symbols) {
    if (candidate === symbol) continue;
    const value = cumulativeReturn(snapshotsByTimestamp.get(candidate) || new Map(), snapshot.timestamp, hours);
    if (value !== null) values.push(value);
  }
  return average(values);
}

function covariance(left, right) {
  if (left.length !== right.length || !left.length) return null;
  const leftMean = average(left);
  const rightMean = average(right);
  return average(left.map((value, index) => (value - leftMean) * (right[index] - rightMean)));
}

function rollingBeta(symbol, timestamp, rowMaps, snapshotsByTimestamp, {
  windowHours = M13_BETA_WINDOW_HOURS,
  minimumObservations = M13_MIN_BETA_OBSERVATIONS,
  returnTables = null,
  marketReturnsByTimestamp = null,
} = {}) {
  const target = rowMaps.get(symbol) || new Map();
  const targetReturns = [];
  const marketReturns = [];
  // Strictly prior returns keep the beta fit independent of the current
  // snapshot.  This also makes appending a future candle unable to revise it.
  for (let offset = windowHours; offset >= 1; offset -= 1) {
    const at = timestamp - offset * HOUR;
    const snapshot = snapshotsByTimestamp.get(at);
    if (!snapshot) continue;
    const targetReturn = returnTables?.get(symbol)?.get(at)?.[1] ?? returnAt(target, at);
    const marketReturn = marketReturnsByTimestamp?.get(at)?.get(symbol)
      ?? currentMarketReturn(snapshot, rowMaps, symbol);
    if (targetReturn === null || marketReturn === null) continue;
    targetReturns.push(targetReturn);
    marketReturns.push(marketReturn);
  }
  if (targetReturns.length < minimumObservations) {
    return { beta: null, observations: targetReturns.length, fitted: false };
  }
  const marketVariance = covariance(marketReturns, marketReturns);
  const beta = marketVariance && marketVariance > 0
    ? covariance(targetReturns, marketReturns) / marketVariance
    : null;
  return {
    beta: finite(beta),
    observations: targetReturns.length,
    fitted: finite(beta) !== null,
  };
}

function buildReturnTables(snapshots, rowMaps) {
  const horizons = [1, 4, 8, 12, 24];
  const returnTables = new Map([...rowMaps.keys()].map(symbol => [symbol, new Map()]));
  const marketReturnsByTimestamp = new Map();
  const marketCumulativeByTimestamp = new Map();
  const participationByTimestamp = new Map();
  const dispersionByTimestamp = new Map();
  for (const snapshot of snapshots) {
    const bySymbol = new Map();
    for (const symbol of snapshot.valid_symbols || []) {
      const table = returnTables.get(symbol) || new Map();
      const values = Object.fromEntries(horizons.map(hours => [
        hours,
        cumulativeReturn(rowMaps.get(symbol) || new Map(), snapshot.timestamp, hours),
      ]));
      table.set(snapshot.timestamp, values);
      returnTables.set(symbol, table);
      bySymbol.set(symbol, values);
    }
    const marketAtTimestamp = new Map();
    const cumulativeAtTimestamp = new Map();
    for (const hours of horizons) {
      const values = [...bySymbol.entries()]
        .map(([symbol, values]) => [symbol, values[hours]])
        .filter(([, value]) => value !== null);
      const total = values.reduce((sum, [, value]) => sum + value, 0);
      for (const [symbol, value] of values) {
        const others = values.length - 1;
        if (!marketAtTimestamp.has(symbol)) marketAtTimestamp.set(symbol, {});
        if (!cumulativeAtTimestamp.has(symbol)) cumulativeAtTimestamp.set(symbol, {});
        marketAtTimestamp.get(symbol)[hours] = others > 0 ? (total - value) / others : null;
        cumulativeAtTimestamp.get(symbol)[hours] = others > 0 ? (total - value) / others : null;
      }
    }
    marketReturnsByTimestamp.set(snapshot.timestamp, new Map(
      [...marketAtTimestamp.entries()].map(([symbol, value]) => [symbol, value[1] ?? null]),
    ));
    marketCumulativeByTimestamp.set(snapshot.timestamp, new Map(
      [...cumulativeAtTimestamp.entries()].map(([symbol, value]) => [symbol, value]),
    ));
    const oneHour = [...bySymbol.values()].map(values => values[1]).filter(value => value !== null);
    const mean = average(oneHour);
    dispersionByTimestamp.set(snapshot.timestamp, standardDeviation(oneHour, mean));
    const participation = snapshot.valid_symbols.map(symbol => [
      symbol,
      candleParticipation(snapshot.candles[symbol]),
    ]).filter(([, value]) => value !== null && value > 0);
    const sortedParticipation = participation.map(([, value]) => value).sort((left, right) => left - right);
    participationByTimestamp.set(snapshot.timestamp, {
      median: sortedParticipation.length ? sortedParticipation[Math.floor(sortedParticipation.length / 2)] : null,
      values: new Map(participation),
    });
  }
  return {
    returnTables,
    marketReturnsByTimestamp,
    marketCumulativeByTimestamp,
    participationByTimestamp,
    dispersionByTimestamp,
  };
}

function rollingPastValues(valuesByTimestamp, timestamp, windowHours = M13_BETA_WINDOW_HOURS) {
  const values = [];
  for (let offset = windowHours; offset >= 1; offset -= 1) {
    const value = finite(valuesByTimestamp.get(timestamp - offset * HOUR));
    if (value !== null) values.push(value);
  }
  return values;
}

function snapshotReturns(snapshot, rowMaps) {
  return snapshot.valid_symbols
    .map(symbol => returnAt(rowMaps.get(symbol) || new Map(), snapshot.timestamp))
    .filter(value => value !== null);
}

function breadthStats(snapshot, rowMaps) {
  const returns = snapshotReturns(snapshot, rowMaps);
  const positive = returns.filter(value => value > 0).length;
  const negative = returns.filter(value => value < 0).length;
  return {
    breadth_positive_ratio: returns.length ? positive / returns.length : null,
    breadth_negative_ratio: returns.length ? negative / returns.length : null,
    breadth_signal: returns.length ? (positive - negative) / returns.length : null,
    breadth_observations: returns.length,
  };
}

function dispersionStats(snapshot, rowMaps, snapshotsByTimestamp, {
  windowHours = M13_BETA_WINDOW_HOURS,
  dispersionByTimestamp = null,
} = {}) {
  const currentReturns = dispersionByTimestamp ? null : snapshotReturns(snapshot, rowMaps);
  const currentMean = currentReturns ? average(currentReturns) : null;
  const dispersion = dispersionByTimestamp?.get(snapshot.timestamp)
    ?? standardDeviation(currentReturns || [], currentMean);
  const prior = dispersionByTimestamp
    ? rollingPastValues(dispersionByTimestamp, snapshot.timestamp, windowHours).filter(value => value !== null)
    : [];
  const priorDispersion = new Map();
  for (let offset = windowHours; offset >= 1; offset -= 1) {
    if (dispersionByTimestamp) break;
    const priorSnapshot = snapshotsByTimestamp.get(snapshot.timestamp - offset * HOUR);
    if (!priorSnapshot) continue;
    const values = snapshotReturns(priorSnapshot, rowMaps);
    priorDispersion.set(priorSnapshot.timestamp, standardDeviation(values, average(values)));
  }
  const priorValues = prior.length ? prior : [...priorDispersion.values()].filter(value => value !== null);
  const mean = average(priorValues);
  const deviation = standardDeviation(priorValues, mean);
  return {
    dispersion_1h: dispersion,
    dispersion_zscore: dispersion === null || mean === null
      ? null
      : deviation && deviation > 0 ? (dispersion - mean) / deviation : 0,
    dispersion_history_observations: priorValues.length,
  };
}

function leaderReturn(snapshot, rowMaps, hours = 4, returnTables = null) {
  const leaders = ['BTCUSDT', 'ETHUSDT']
    .filter(symbol => snapshot.valid_symbols.includes(symbol))
    .map(symbol => returnTables?.get(symbol)?.get(snapshot.timestamp)?.[hours]
      ?? cumulativeReturn(rowMaps.get(symbol) || new Map(), snapshot.timestamp, hours))
    .filter(value => value !== null);
  return average(leaders);
}

function normalizeFeatureRows(rows, snapshot) {
  const fields = [
    'relative_momentum_1h',
    'relative_momentum_4h',
    'relative_momentum_8h',
    'relative_momentum_24h',
    'residual_momentum_1h',
    'residual_momentum_4h',
    'residual_momentum_8h',
    'residual_momentum_24h',
    'lead_lag_continuation',
    'lead_lag_reversal',
    'relative_participation',
    'dispersion_1h',
  ];
  for (const field of fields) {
    const normalized = crossSectionNormalize(rows.map(row => ({
      symbol: row.symbol,
      value: row[field],
    })));
    const bySymbol = new Map(normalized.map(item => [item.symbol, item]));
    for (const row of rows) {
      const item = bySymbol.get(row.symbol);
      row[`${field}_rank`] = item?.rank ?? null;
      row[`${field}_percentile`] = item?.percentile ?? null;
      row[`${field}_zscore`] = item?.zscore ?? null;
    }
  }
  return rows;
}

/**
 * Build point-in-time relative features from admitted snapshots.  Every value
 * is either from the current closed candle or from an exact prior timestamp;
 * rolling beta and dispersion history intentionally exclude the current row.
 */
export function buildCrossSectionalFeatures(input = {}, options = {}) {
  const settings = Array.isArray(input)
    ? { ...options, snapshots: input }
    : { ...input };
  const snapshotResult = settings.snapshots
    ? {
      snapshots: settings.snapshots,
      rejected_snapshots: settings.rejected_snapshots || [],
      symbols: settings.symbols || [...new Set(settings.snapshots.flatMap(snapshot => snapshot.valid_symbols || []))].sort(),
      min_valid_symbols: settings.minValidSymbols ?? M13_MIN_VALID_SYMBOLS,
    }
    : buildCrossSectionSnapshots(settings);
  const snapshots = [...(snapshotResult.snapshots || [])]
    .sort((left, right) => left.timestamp - right.timestamp);
  const rowMaps = new Map();
  for (const snapshot of snapshots) {
    for (const symbol of snapshot.valid_symbols || []) {
      if (!rowMaps.has(symbol)) rowMaps.set(symbol, new Map());
      rowMaps.get(symbol).set(snapshot.timestamp, snapshot.candles[symbol]);
    }
  }
  const snapshotsByTimestamp = new Map(snapshots.map(snapshot => [snapshot.timestamp, snapshot]));
  const returnTables = buildReturnTables(snapshots, rowMaps);
  const rows = [];
  const rowsByTimestamp = new Map();
  for (const snapshot of snapshots) {
    const breadth = breadthStats(snapshot, rowMaps);
    const dispersion = dispersionStats(snapshot, rowMaps, snapshotsByTimestamp, {
      ...settings,
      dispersionByTimestamp: returnTables.dispersionByTimestamp,
    });
    const leader = leaderReturn(snapshot, rowMaps, 4, returnTables.returnTables);
    const snapshotParticipation = returnTables.participationByTimestamp.get(snapshot.timestamp) || {};
    const snapshotRows = [];
    for (const symbol of snapshot.valid_symbols || []) {
      const targetRows = rowMaps.get(symbol) || new Map();
      const targetReturnTable = returnTables.returnTables.get(symbol)?.get(snapshot.timestamp) || {};
      const marketReturnTable = returnTables.marketCumulativeByTimestamp.get(snapshot.timestamp)?.get(symbol) || {};
      const targetReturn1h = targetReturnTable[1] ?? null;
      const marketReturn1h = returnTables.marketReturnsByTimestamp.get(snapshot.timestamp)?.get(symbol) ?? null;
      const relativeMomentum = {};
      const residualMomentum = {};
      for (const hours of [1, 4, 8, 24]) {
        const targetReturn = targetReturnTable[hours] ?? null;
        const marketReturn = marketReturnTable[hours] ?? null;
        relativeMomentum[hours] = targetReturn === null || marketReturn === null
          ? null
          : targetReturn - marketReturn;
      }
      const beta = rollingBeta(symbol, snapshot.timestamp, rowMaps, snapshotsByTimestamp, {
        ...settings,
        returnTables: returnTables.returnTables,
        marketReturnsByTimestamp: returnTables.marketReturnsByTimestamp,
      });
      for (const hours of [1, 4, 8, 24]) {
        const targetReturn = targetReturnTable[hours] ?? null;
        const marketReturn = marketReturnTable[hours] ?? null;
        residualMomentum[hours] = targetReturn === null || marketReturn === null || beta.beta === null
          ? null
          : targetReturn - beta.beta * marketReturn;
      }
      const targetReturn4h = targetReturnTable[4] ?? null;
      const targetReturn8h = targetReturnTable[8] ?? null;
      const targetReturn12h = targetReturnTable[12] ?? null;
      const targetReturn24h = targetReturnTable[24] ?? null;
      const continuation = leader === null || targetReturn4h === null ? null : leader - targetReturn4h;
      const participationMedian = snapshotParticipation.median ?? null;
      const participation = candleParticipation(snapshot.candles[symbol]);
      const relativeParticipation = participation === null || participationMedian === null || participationMedian <= 0
        ? null
        : Math.log(participation / participationMedian);
      const candle = snapshot.candles[symbol];
      snapshotRows.push({
        feature_version: M13_FEATURE_VERSION,
        timestamp: snapshot.timestamp,
        signal_timestamp: snapshot.timestamp + 1,
        close_time: snapshot.timestamp,
        open_time: candle?.open_time ?? snapshot.open_time ?? null,
        snapshot_event_id: snapshot.snapshot_event_id,
        independent_market_event_id: snapshot.independent_market_event_id,
        market_event_id: snapshot.independent_market_event_id,
        symbol,
        valid_symbol_count: snapshot.valid_symbol_count,
        valid_symbols: [...snapshot.valid_symbols],
        candle_index: candle?.candle_index ?? null,
        open: finite(candle?.open),
        high: finite(candle?.high),
        low: finite(candle?.low),
        close: finite(candle?.close),
        volume: finite(candle?.volume),
        quote_volume: finite(candle?.quote_volume),
        target_return_1h: targetReturn1h,
        target_return_4h: targetReturn4h,
        target_return_8h: targetReturn8h,
        target_return_12h: targetReturn12h,
        target_return_24h: targetReturn24h,
        market_return_1h: marketReturn1h,
        market_factor_return_1h: marketReturn1h,
        beta_168h: beta.beta,
        beta_observations: beta.observations,
        beta_fitted: beta.fitted,
        breadth_positive_ratio: breadth.breadth_positive_ratio,
        breadth_negative_ratio: breadth.breadth_negative_ratio,
        breadth_signal: breadth.breadth_signal,
        breadth_observations: breadth.breadth_observations,
        dispersion_1h: dispersion.dispersion_1h,
        dispersion_zscore: dispersion.dispersion_zscore,
        dispersion_history_observations: dispersion.dispersion_history_observations,
        btc_eth_leader_return_4h: leader,
        lead_lag_continuation: continuation,
        lead_lag_reversal: continuation === null ? null : -continuation,
        participation: participation,
        relative_participation: relativeParticipation,
        relative_participation_rank: null,
        relative_participation_percentile: null,
        relative_participation_zscore: null,
        relative_momentum_1h: relativeMomentum[1],
        relative_momentum_4h: relativeMomentum[4],
        relative_momentum_8h: relativeMomentum[8],
        relative_momentum_24h: relativeMomentum[24],
        residual_momentum_1h: residualMomentum[1],
        residual_momentum_4h: residualMomentum[4],
        residual_momentum_8h: residualMomentum[8],
        residual_momentum_24h: residualMomentum[24],
        residual_reversal_4h: residualMomentum[4] === null ? null : -residualMomentum[4],
        residual_reversal_8h: residualMomentum[8] === null ? null : -residualMomentum[8],
        point_in_time: true,
        future_data_used: false,
      });
    }
    rowsByTimestamp.set(snapshot.timestamp, snapshotRows);
    rows.push(...snapshotRows);
  }
  for (const snapshot of snapshots) {
    normalizeFeatureRows(rowsByTimestamp.get(snapshot.timestamp) || [], snapshot);
  }
  return {
    feature_version: M13_FEATURE_VERSION,
    snapshots,
    rejected_snapshots: snapshotResult.rejected_snapshots || [],
    features: rows,
    feature_rows: rows,
    symbols: snapshotResult.symbols || [],
    snapshot_count: snapshots.length,
    rejected_snapshot_count: (snapshotResult.rejected_snapshots || []).length,
    min_valid_symbols: snapshotResult.min_valid_symbols ?? M13_MIN_VALID_SYMBOLS,
    beta_window_hours: settings.windowHours ?? M13_BETA_WINDOW_HOURS,
    beta_minimum_observations: settings.minimumObservations ?? M13_MIN_BETA_OBSERVATIONS,
    point_in_time: true,
    future_data_used: false,
  };
}

/** Attach same-timestamp derivative ranks without fitting on outcomes. */
export function attachCrossSectionalDerivativeRanks(rows = [], {
  families = ['Funding', 'Open Interest', 'Basis/Premium', 'Taker Flow'],
} = {}) {
  const allowed = [...new Set(families)];
  const byTimestamp = new Map();
  for (const row of rows) {
    if (!byTimestamp.has(row.timestamp)) byTimestamp.set(row.timestamp, []);
    byTimestamp.get(row.timestamp).push(row);
  }
  for (const members of byTimestamp.values()) {
    const composite = new Map();
    for (const row of members) {
      const values = allowed.map(family => finite(
        row.derivatives?.[family]?.representative_value
          ?? row.derivatives?.[family]?.value,
      )).filter(value => value !== null);
      composite.set(row.symbol, values.length ? average(values) : null);
    }
    const normalized = crossSectionNormalize([...composite.entries()].map(([symbol, value]) => ({ symbol, value })));
    for (const item of normalized) {
      const row = members.find(candidate => candidate.symbol === item.symbol);
      if (!row) continue;
      row.derivative_rank = item.rank;
      row.derivative_percentile = item.percentile;
      row.derivative_zscore = item.zscore;
      row.derivative_rank_signal = item.percentile === null ? null : (item.percentile - 0.5) * 2;
      row.derivative_rank_families = allowed;
      row.derivative_rank_valid = item.valid === true;
    }
  }
  return rows;
}

function candidateDefinition(candidateOrId) {
  if (typeof candidateOrId === 'string') return CANDIDATE_BY_ID.get(candidateOrId) || { candidate_id: candidateOrId };
  return candidateOrId || {};
}

function candidateSignalValue(row, candidateOrId) {
  const candidate = candidateDefinition(candidateOrId);
  const id = candidate.candidate_id || '';
  const relative = finite(row.relative_momentum_8h);
  const residual = finite(row.residual_momentum_8h);
  const reversal = finite(row.residual_reversal_4h);
  const breadth = finite(row.breadth_signal);
  const dispersion = finite(row.dispersion_zscore);
  const leadContinuation = finite(row.lead_lag_continuation);
  const leadReversal = finite(row.lead_lag_reversal);
  const participation = finite(row.relative_participation_zscore);
  const derivative = finite(row.derivative_rank_signal);
  if (id.startsWith('X0-')) return finite(row.candle_return_8h ?? row.target_return_8h);
  if (id.startsWith('X1-')) return relative;
  if (id.startsWith('X2-')) return residual;
  if (id.startsWith('X3-')) return reversal;
  if (id.startsWith('X4-')) return relative === null || breadth === null ? null : relative * (0.5 + breadth);
  if (id.startsWith('X5-')) return residual === null || breadth === null ? null : residual * (0.5 + breadth);
  if (id.startsWith('X6-')) return relative === null || dispersion === null ? null : relative * (0.5 + Math.max(0, dispersion));
  if (id.startsWith('X7-')) return reversal === null || dispersion === null ? null : reversal * (0.5 + Math.max(0, dispersion));
  if (id.startsWith('X8-')) return leadContinuation;
  if (id.startsWith('X9-')) return leadReversal;
  if (id.startsWith('X10-')) return residual === null || participation === null ? null : residual + participation * 0.01;
  if (id.startsWith('X11-')) return residual === null || derivative === null ? null : residual + derivative * 0.01;
  return null;
}

/** Score a candidate in one direction; the score is ordinal, never a probability. */
export function scoreCrossSectionalCandidate(row = {}, candidateOrId, direction = 'BUY') {
  const signalValue = candidateSignalValue(row, candidateOrId);
  const signedValue = signalValue === null ? null : directionName(direction) === 'SELL' ? -signalValue : signalValue;
  const rawScore = tanhScore(signedValue, 0.01);
  return {
    candidate_id: candidateDefinition(candidateOrId).candidate_id || String(candidateOrId || ''),
    direction: directionName(direction),
    signal_value: round(signalValue, 12),
    signed_signal_value: round(signedValue, 12),
    raw_score: rawScore,
    edge_score: rawScore,
    score_semantics: 'ranking_score_not_probability',
    point_in_time: true,
    future_data_used: false,
  };
}

function directionalReturn(direction, entry, exit) {
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry === 0) return null;
  return round((direction === 'SELL' ? (entry - exit) / entry : (exit - entry) / entry) * 100, 6);
}

function evaluateResearchSeries({
  direction,
  candles = [],
  signalIndex,
  entryPrice,
  targetPrice,
  stopLoss,
  roundTripCostPercent,
  horizons,
} = {}) {
  const index = Number.isInteger(signalIndex) ? signalIndex : -1;
  const entryCandle = candles[index];
  const entryTime = candleCloseTime(entryCandle);
  const entry = finite(entryPrice ?? entryCandle?.close);
  const result = {
    forward_returns: Object.fromEntries(horizons.map(horizon => [`${horizon}h`, null])),
    net_forward_returns: Object.fromEntries(horizons.map(horizon => [`${horizon}h`, null])),
    mfe_percent: null,
    mae_percent: null,
    tp_first: false,
    sl_first: false,
    neither: null,
    ambiguous: null,
    barrier_outcome: null,
    conservative_barrier_outcome: null,
    barriers_defined: finite(targetPrice) !== null && finite(stopLoss) !== null,
  };
  if (!entryCandle || entry === null || entry <= 0 || entryTime === null) return result;
  const maxHorizon = Math.max(...horizons.map(Number).filter(Number.isFinite), 0);
  let maxMfe = 0;
  let maxMae = 0;
  let firstTarget = null;
  let firstStop = null;
  const target = finite(targetPrice);
  const stop = finite(stopLoss);
  for (let offset = 1; offset < candles.length - index; offset += 1) {
    const candle = candles[index + offset];
    const time = candleCloseTime(candle);
    if (time === null || time > entryTime + maxHorizon * HOUR) break;
    const high = finite(candle.high) ?? finite(candle.close) ?? entry;
    const low = finite(candle.low) ?? finite(candle.close) ?? entry;
    const favorable = direction === 'SELL' ? entry - low : high - entry;
    const adverse = direction === 'SELL' ? entry - high : low - entry;
    maxMfe = Math.max(maxMfe, favorable / entry * 100);
    maxMae = Math.min(maxMae, adverse / entry * 100);
    const hitTarget = target !== null && (direction === 'BUY' ? high >= target : low <= target);
    const hitStop = stop !== null && (direction === 'BUY' ? low <= stop : high >= stop);
    if (hitTarget && firstTarget === null) firstTarget = offset;
    if (hitStop && firstStop === null) firstStop = offset;
  }
  result.mfe_percent = round(Math.max(0, maxMfe), 6);
  result.mae_percent = round(Math.min(0, maxMae), 6);
  if (result.barriers_defined) {
    result.tp_first = firstTarget !== null && (firstStop === null || firstTarget < firstStop);
    result.sl_first = firstStop !== null && (firstTarget === null || firstStop < firstTarget);
    result.neither = firstTarget === null && firstStop === null;
    result.ambiguous = firstTarget !== null && firstStop !== null && firstTarget === firstStop;
    result.barrier_outcome = result.ambiguous
      ? 'ambiguous_same_candle'
      : result.tp_first ? 'tp_first' : result.sl_first ? 'sl_first' : 'neither';
    result.conservative_barrier_outcome = result.ambiguous ? 'sl_first' : result.barrier_outcome;
  }
  for (const horizon of horizons) {
    const targetTime = entryTime + Number(horizon) * HOUR;
    const future = candles.slice(index + 1).find(candle => candleCloseTime(candle) >= targetTime);
    const gross = directionalReturn(direction, entry, finite(future?.close));
    result.forward_returns[`${horizon}h`] = gross;
    result.net_forward_returns[`${horizon}h`] = gross === null
      ? null
      : round(gross - roundTripCostPercent, 6);
  }
  return result;
}

/** Generate independent BUY and SELL research samples for every valid row. */
export function buildDirectionalSamples(input = {}, options = {}) {
  const settings = Array.isArray(input) ? { ...options, featureRows: input } : { ...input };
  const featureRows = settings.featureRows || settings.features || [];
  const candlesBySymbol = settings.candlesBySymbol || {};
  const roundTripCostPercent = settings.roundTripCostPercent ?? M13_ROUND_TRIP_COST_PERCENT;
  const horizons = settings.horizons || M13_HORIZONS_HOURS;
  const candidateId = settings.candidateId || settings.candidate?.candidate_id || 'X1-relative-momentum';
  const candidate = candidateDefinition(settings.candidate || candidateId);
  const barrierOptions = settings.barrierOptions || {};
  const rows = [...featureRows]
    .filter(row => row && row.point_in_time !== false)
    .sort((left, right) => left.timestamp - right.timestamp || left.symbol.localeCompare(right.symbol));
  const seriesBySymbol = new Map([...new Set(rows.map(row => row.symbol))].map(symbol => [
    symbol,
    normalizedSeries(candlesBySymbol[symbol] || [], symbol),
  ]));
  const samples = [];
  for (const row of rows) {
    for (const direction of ['BUY', 'SELL']) {
      const score = scoreCrossSectionalCandidate(row, candidate, direction);
      const candles = seriesBySymbol.get(row.symbol) || [];
      const entryPrice = finite(row.close);
      const barrier = buildResearchBarriers({
        direction,
        entryPrice,
        candles: row.candle_index === null || row.candle_index === undefined
          ? candles.slice(0, 15)
          : candles.slice(Math.max(0, row.candle_index - 14), row.candle_index + 1),
        options: barrierOptions,
      });
      const signal = {
        symbol: row.symbol,
        direction,
        signal_timestamp: row.signal_timestamp ?? row.timestamp + 1,
        trigger_time: row.timestamp,
        suggestedEntry: entryPrice,
        targetPrice: barrier.target_price,
        stopLoss: barrier.stop_loss,
        barrier_version: barrier.barrier_version,
      };
      const evaluation = evaluateResearchSeries({
        direction,
        candles,
        signalIndex: row.candle_index,
        entryPrice,
        targetPrice: barrier.target_price,
        stopLoss: barrier.stop_loss,
        roundTripCostPercent,
        horizons,
      });
      const primaryHorizon = candidate.primary_horizon_hours || 8;
      const primaryKey = `${primaryHorizon}h`;
      samples.push({
        record_index: samples.length,
        candidate_id: candidate.candidate_id || candidateId,
        feature_version: M13_FEATURE_VERSION,
        model_version: M13_MODEL_VERSION,
        symbol: row.symbol,
        direction,
        timestamp: row.timestamp,
        signal_timestamp: signal.signal_timestamp,
        label_end_time: row.timestamp + Math.max(...M13_HORIZONS_HOURS) * HOUR,
        snapshot_event_id: row.snapshot_event_id,
        independent_market_event_id: row.independent_market_event_id,
        market_event_id: row.independent_market_event_id,
        setup_family: 'Cross-Sectional Relative Value',
        trend_regime: 'Cross-Sectional',
        volatility_regime: finite(row.dispersion_zscore) !== null && row.dispersion_zscore > 1 ? 'High' : 'Normal',
        valid_symbol_count: row.valid_symbol_count,
        valid_symbols: row.valid_symbols,
        raw_score: score.raw_score,
        edge_score: score.edge_score,
        signal_value: score.signal_value,
        signed_signal_value: score.signed_signal_value,
        score_semantics: score.score_semantics,
        feature_snapshot: row,
        relative_momentum_8h: row.relative_momentum_8h,
        residual_momentum_8h: row.residual_momentum_8h,
        residual_reversal_4h: row.residual_reversal_4h,
        breadth_signal: row.breadth_signal,
        dispersion_zscore: row.dispersion_zscore,
        lead_lag_continuation: row.lead_lag_continuation,
        lead_lag_reversal: row.lead_lag_reversal,
        relative_participation_zscore: row.relative_participation_zscore,
        derivative_rank_signal: row.derivative_rank_signal ?? null,
        primary_horizon_hours: primaryHorizon,
        primary_outcome: finite(evaluation.net_forward_returns?.[primaryKey]),
        primary_gross_outcome_percent: finite(evaluation.forward_returns?.[primaryKey]),
        forward_returns: evaluation.forward_returns,
        net_forward_returns: evaluation.net_forward_returns,
        mfe_percent: evaluation.mfe_percent,
        mae_percent: evaluation.mae_percent,
        tp_first: evaluation.tp_first,
        sl_first: evaluation.sl_first,
        neither: evaluation.neither,
        ambiguous: evaluation.ambiguous,
        barrier_outcome: evaluation.barrier_outcome,
        conservative_barrier_outcome: evaluation.conservative_barrier_outcome,
        barriers_defined: evaluation.barriers_defined,
        barrier_version: evaluation.barrier_version || RESEARCH_BARRIER_VERSION,
        barrier_config_hash: barrier.barrier_config_hash,
        point_in_time: true,
        future_data_used: false,
      });
    }
  }
  return samples;
}

export const generateCrossSectionalSamples = buildDirectionalSamples;

function selectionKey(sample, index) {
  return `${sample?.snapshot_event_id || `timestamp:${sample?.timestamp ?? index}`}|${directionName(sample?.direction)}`;
}

function sampleScore(sample) {
  return finite(sample?.edge_score) ?? finite(sample?.raw_score) ?? -Infinity;
}

/** Fit only fixed, predeclared research policy metadata from the train rows. */
export function fitM13Policy(trainSamples = [], candidateOrId = {}) {
  const candidate = candidateDefinition(candidateOrId);
  const timestamps = trainSamples.map(sample => timestampValue(sample?.timestamp)).filter(value => value !== null);
  return {
    version: M13_MODEL_VERSION,
    feature_version: M13_FEATURE_VERSION,
    training_only: true,
    outcome_independent: true,
    candidate_id: candidate.candidate_id || null,
    selection_group: 'snapshot_event_id|direction',
    cluster_top_n: 1,
    score_field: 'edge_score',
    score_threshold: null,
    independent_generator: candidate.independent_generator === true,
    training_sample_count: trainSamples.length,
    training_timestamp_start: timestamps.length ? Math.min(...timestamps) : null,
    training_timestamp_end: timestamps.length ? Math.max(...timestamps) : null,
    label_fields_not_read: true,
    summary: {
      version: M13_MODEL_VERSION,
      candidate_id: candidate.candidate_id || null,
      selection_group: 'snapshot_event_id|direction',
      cluster_top_n: 1,
      score_field: 'edge_score',
      score_threshold: null,
      training_only: true,
      outcome_independent: true,
      label_fields_not_read: true,
    },
  };
}

/** Select at most one BUY and one SELL in each exact snapshot. */
export function predictM13Selections(testSamples = [], model = {}) {
  const annotated = testSamples.map((sample, index) => {
    const eligible = sampleScore(sample) !== -Infinity
      && sample?.point_in_time !== false
      && sample?.future_data_used !== true;
    return {
      sample,
      sample_index: index,
      raw_score_eligible: eligible,
      score_threshold_eligible: eligible,
      score_eligible: eligible,
      eligible,
      cluster_selected: false,
      selected: false,
      selection_status: eligible ? 'SCORE_ELIGIBLE_NOT_SELECTED' : 'SCORE_INELIGIBLE',
      oos_cluster_rank: null,
      oos_ranking_bucket: eligible ? 'WATCH' : 'SHADOW',
    };
  });
  const groups = new Map();
  for (const item of annotated) {
    if (!item.eligible) continue;
    const key = selectionKey(item.sample, item.sample_index);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  for (const members of groups.values()) {
    members.sort((left, right) => sampleScore(right.sample) - sampleScore(left.sample)
      || String(left.sample?.symbol || '').localeCompare(String(right.sample?.symbol || ''))
      || (left.sample?.record_index ?? left.sample_index) - (right.sample?.record_index ?? right.sample_index));
    members.forEach((item, index) => {
      item.oos_cluster_rank = index + 1;
      if (index === 0) {
        item.cluster_selected = true;
        item.selected = true;
        item.selection_status = 'CLUSTER_SELECTED';
        item.oos_ranking_bucket = 'CLUSTER_SELECTED';
      }
    });
  }
  return annotated;
}

function netOutcome(record, horizonHours = record?.primary_horizon_hours || 8) {
  const key = `${Number(horizonHours)}h`;
  return finite(record?.primary_outcome)
    ?? finite(record?.net_forward_returns?.[key])
    ?? finite(record?.outcome);
}

function grossOutcome(record, horizonHours = record?.primary_horizon_hours || 8) {
  const key = `${Number(horizonHours)}h`;
  return finite(record?.primary_gross_outcome_percent)
    ?? finite(record?.forward_returns?.[key]);
}

function profitFactor(values) {
  const wins = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return losses ? wins / losses : wins > 0 ? 999 : 0;
}

function quantile(values, probability) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? sorted[lower] : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function eventIds(records = []) {
  return new Set(records.map(record => record.independent_market_event_id || record.market_event_id).filter(Boolean));
}

function selectedRecords(records = []) {
  return records.filter(record => record.selected === true);
}

function forwardMetrics(records, horizon) {
  const net = records.map(record => finite(record?.net_forward_returns?.[`${horizon}h`])).filter(value => value !== null);
  const gross = records.map(record => finite(record?.forward_returns?.[`${horizon}h`])).filter(value => value !== null);
  return {
    count: net.length,
    net_expectancy_percent: round(average(net), 8),
    gross_expectancy_percent: round(average(gross), 8),
    net_profit_factor: net.length ? round(profitFactor(net), 6) : null,
    gross_profit_factor: gross.length ? round(profitFactor(gross), 6) : null,
    hit_rate_percent: net.length ? round(net.filter(value => value > 0).length / net.length * 100, 6) : null,
  };
}

export function calculateM13Concentration(records = []) {
  const selected = selectedRecords(records);
  const bySymbol = new Map();
  const uniqueEvents = eventIds(selected);
  for (const record of selected) {
    const symbol = symbolName(record.symbol);
    if (!symbol) continue;
    if (!bySymbol.has(symbol)) bySymbol.set(symbol, new Set());
    bySymbol.get(symbol).add(record.independent_market_event_id || record.market_event_id);
  }
  const shares = [...bySymbol.entries()].map(([symbol, ids]) => ({
    symbol,
    independent_events: ids.size,
    share: uniqueEvents.size ? ids.size / uniqueEvents.size : 0,
  })).sort((left, right) => right.share - left.share || left.symbol.localeCompare(right.symbol));
  const max = shares[0] || { symbol: null, independent_events: 0, share: 0 };
  return {
    unique_independent_events: uniqueEvents.size,
    by_symbol: shares,
    max_symbol: max.symbol,
    max_symbol_event_share: round(max.share, 8),
    maximum_allowed_symbol_event_share: M13_PROMOTION_THRESHOLDS.maximum_symbol_event_share,
    concentration_risk: max.share > M13_PROMOTION_THRESHOLDS.maximum_symbol_event_share,
  };
}

export function summarizeM13Records(records = [], {
  primaryHorizonHours = 8,
  horizons = M13_HORIZONS_HOURS,
} = {}) {
  const selected = selectedRecords(records);
  const primary = selected.map(record => netOutcome(record, primaryHorizonHours)).filter(value => value !== null);
  const gross = selected.map(record => grossOutcome(record, primaryHorizonHours)).filter(value => value !== null);
  const symbols = new Set(selected.map(record => record.symbol).filter(Boolean));
  const independentEvents = eventIds(selected);
  const forwardReturns = Object.fromEntries(horizons.map(horizon => [
    `${horizon}h`, forwardMetrics(selected, horizon),
  ]));
  const calibration = buildScoreCalibration(selected.map(record => ({
    raw_score: record.raw_score,
    outcome: netOutcome(record, primaryHorizonHours),
    gross_return_percent: grossOutcome(record, primaryHorizonHours),
    mfe_percent: record.mfe_percent,
    mae_percent: record.mae_percent,
  })), { binCount: 5, minimumSamplesPerBin: 5 });
  return {
    sample_count: records.length,
    selected_oos_signals: selected.length,
    evaluated_count: primary.length,
    independent_market_events: independentEvents.size,
    symbol_breadth: symbols.size,
    direction_breadth: Object.fromEntries(['BUY', 'SELL'].map(direction => [
      direction,
      selected.filter(record => directionName(record.direction) === direction).length,
    ])),
    gross_expectancy_percent: round(average(gross), 8),
    net_expectancy_percent: round(average(primary), 8),
    gross_profit_factor: gross.length ? round(profitFactor(gross), 6) : null,
    net_profit_factor: primary.length ? round(profitFactor(primary), 6) : null,
    hit_rate_percent: primary.length ? round(primary.filter(value => value > 0).length / primary.length * 100, 8) : null,
    false_positive_rate_percent: primary.length ? round(primary.filter(value => value <= 0).length / primary.length * 100, 8) : null,
    avg_mfe_percent: round(average(selected.map(record => record.mfe_percent)), 8),
    avg_mae_percent: round(average(selected.map(record => record.mae_percent)), 8),
    tp_first_count: selected.filter(record => record.tp_first || record.barrier_outcome === 'tp_first').length,
    sl_first_count: selected.filter(record => record.sl_first || record.barrier_outcome === 'sl_first').length,
    ambiguous_count: selected.filter(record => record.ambiguous || record.barrier_outcome === 'ambiguous_same_candle').length,
    forward_returns: forwardReturns,
    primary_horizon_hours: primaryHorizonHours,
    primary_metrics_selected_only: true,
    score_calibration: calibration,
  };
}

function windowMetrics(oosRecords, windows, primaryHorizonHours) {
  return (windows || []).map(window => {
    const records = oosRecords.filter(record => record.window_index === window.index && record.selected === true);
    const metrics = summarizeM13Records(records, { primaryHorizonHours });
    return {
      window_index: window.index,
      test_start: window.test_start,
      test_end: window.test_end,
      selected_count: records.length,
      independent_market_events: metrics.independent_market_events,
      net_expectancy_percent: metrics.net_expectancy_percent,
      net_profit_factor: metrics.net_profit_factor,
      positive: (metrics.net_expectancy_percent ?? 0) > 0,
    };
  });
}

function stabilityMetrics(perWindow = []) {
  const expectancies = perWindow.map(window => window.net_expectancy_percent).filter(value => value !== null);
  const positiveWindows = perWindow.filter(window => window.positive).length;
  const ratio = perWindow.length ? positiveWindows / perWindow.length : 0;
  return {
    total_windows: perWindow.length,
    positive_windows: positiveWindows,
    positive_window_ratio: round(ratio, 8),
    median_window_expectancy_percent: round(quantile(expectancies, 0.5), 8),
    worst_window_expectancy_percent: expectancies.length ? round(Math.min(...expectancies), 8) : null,
    window_expectancy_dispersion_percent: expectancies.length ? round(Math.max(...expectancies) - Math.min(...expectancies), 8) : null,
    unstable_edge: perWindow.length > 0 && ratio < 2 / 3,
  };
}

function m13ScoreWindow(predictions = []) {
  const selected = predictions.filter(item => item.selected === true);
  const outcomes = selected.map(item => netOutcome(item.sample, item.sample?.primary_horizon_hours || 8)).filter(value => value !== null);
  const events = new Set(selected.map(item => item.sample?.independent_market_event_id || item.sample?.market_event_id).filter(Boolean));
  return {
    candidate_count: predictions.length,
    score_eligible_count: predictions.filter(item => item.score_eligible === true).length,
    cluster_selected_count: selected.length,
    selected_count: selected.length,
    independent_market_events: events.size,
    expectancy: outcomes.length ? average(outcomes) : null,
    positive: outcomes.length > 0 && average(outcomes) > 0,
  };
}

function deduplicateOosRecords(records = []) {
  const seen = new Set();
  return [...records]
    .sort((left, right) => (left.window_index ?? 0) - (right.window_index ?? 0)
      || (left.timestamp ?? 0) - (right.timestamp ?? 0)
      || String(left.symbol || '').localeCompare(String(right.symbol || ''))
      || String(left.direction || '').localeCompare(String(right.direction || '')))
    .filter(record => {
      const key = record.record_index ?? `${record.snapshot_event_id}|${record.symbol}|${record.direction}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/** Run one candidate with snapshot/direction selection and a purged WFO. */
export function runM13Candidate(samples = [], {
  candidateId = 'X1-relative-momentum',
  candidate = candidateDefinition(candidateId),
  dataSource = 'public_binance_futures_archive',
  wfoOptions = {},
  modelVersion = M13_MODEL_VERSION,
} = {}) {
  const definition = candidateDefinition(candidateId || candidate);
  const primaryHorizonHours = definition.primary_horizon_hours || 8;
  const canonicalPlan = wfoOptions.canonicalPlan || null;
  const defaultHoldout = Math.max(1, Math.floor(samples.length * 0.2));
  const defaultTrain = Math.max(60, Math.floor(samples.length * 0.35));
  const defaultTest = Math.max(24, Math.floor(samples.length * 0.06));
  const options = canonicalPlan
    ? { ...canonicalPlan.options }
    : {
    trainSize: wfoOptions.trainSize ?? defaultTrain,
    testSize: wfoOptions.testSize ?? defaultTest,
    step: wfoOptions.step ?? (wfoOptions.testSize ?? defaultTest),
    finalHoldoutCount: wfoOptions.finalHoldoutCount ?? defaultHoldout,
    purgeHours: wfoOptions.purgeHours ?? 48,
    embargoHours: wfoOptions.embargoHours ?? 24,
    labelHorizonHours: wfoOptions.labelHorizonHours ?? 48,
    minimumTrainSamples: wfoOptions.minimumTrainSamples ?? Math.max(30, Math.floor(defaultTrain * 0.35)),
    minimumWindows: wfoOptions.minimumWindows ?? 6,
    includeFinalHoldoutOutcomeInHash: false,
    };
  const walkForward = runPurgedWalkForward(samples, {
    ...options,
    canonicalPlan,
    scoreWindow: m13ScoreWindow,
    fit: trainSamples => fitM13Policy(trainSamples, definition),
    predict: (testSamples, model) => predictM13Selections(testSamples, model),
  });
  const oosRecords = deduplicateOosRecords(walkForward.oos_samples.map(item => ({
    ...item.sample,
    record_index: item.record_index ?? item.sample?.record_index ?? item.sample_index,
    window_index: item.window_index,
    snapshot_event_id: item.sample?.snapshot_event_id ?? null,
    independent_market_event_id: item.sample?.independent_market_event_id
      ?? item.sample?.market_event_id
      ?? null,
    market_event_id: item.sample?.independent_market_event_id
      ?? item.sample?.market_event_id
      ?? null,
    raw_score_eligible: item.raw_score_eligible === true,
    score_threshold_eligible: item.score_threshold_eligible === true,
    score_eligible: item.score_eligible === true,
    cluster_selected: item.cluster_selected === true,
    selected: item.selected === true,
    selection_status: item.selection_status || (item.selected ? 'CLUSTER_SELECTED' : 'SCORE_INELIGIBLE'),
    oos_cluster_rank: item.oos_cluster_rank ?? null,
    oos_ranking_bucket: item.oos_ranking_bucket ?? null,
  })));
  const selected = selectedRecords(oosRecords);
  const allMetrics = summarizeM13Records(oosRecords.map(record => ({ ...record, selected: true })), { primaryHorizonHours });
  const metrics = summarizeM13Records(selected, { primaryHorizonHours });
  const perWindow = windowMetrics(oosRecords, walkForward.windows, primaryHorizonHours);
  const stability = stabilityMetrics(perWindow);
  const concentration = calculateM13Concentration(selected);
  const configHash = hashConfig({ model_version: modelVersion, candidate: definition, wfo_options: options });
  return {
    candidate_id: definition.candidate_id || candidateId,
    model_version: modelVersion,
    feature_version: M13_FEATURE_VERSION,
    candidate: {
      ...definition,
      config_hash: configHash,
    },
    data_source: dataSource,
    config_hash: configHash,
    walk_forward: walkForward,
    oos_records: oosRecords,
    selected_records: selected,
    metrics,
    all_oos_metrics: allMetrics,
    selection: {
      all_candidates: oosRecords.length,
      score_eligible_candidates: oosRecords.filter(record => record.score_eligible).length,
      cluster_selected_candidates: selected.length,
      independent_market_events: eventIds(selected).size,
      independent_generator: definition.independent_generator === true,
      selection_group: 'snapshot_event_id|direction',
      maximum_selected_per_snapshot_direction: 1,
    },
    per_window: perWindow,
    stability,
    concentration,
    calibration: metrics.score_calibration,
    final_holdout_untouched: walkForward.final_holdout_untouched === true,
    model_summaries: walkForward.trained_policy_summary,
  };
}

function supportKey(record) {
  return [
    record.timestamp ?? 'NA',
    record.snapshot_event_id ?? 'NA',
    symbolName(record.symbol),
    directionName(record.direction),
  ].join('|');
}

function supportMap(records = []) {
  return new Map(records.map(record => [supportKey(record), record]));
}

function wfoBoundaryWindows(result = {}) {
  return result?.walk_forward?.windows || [];
}

function windowField(window, name, legacyName = name) {
  const aliases = {
    train_start_timestamp: 'train_start',
    train_end_timestamp: 'train_end',
    purge_start_timestamp: 'purge_start',
    purge_end_timestamp: 'purge_end',
    test_start_timestamp: 'test_start',
    test_end_timestamp: 'test_end',
    embargo_start_timestamp: 'embargo_start',
    embargo_end_timestamp: 'embargo_end',
  };
  return window?.[name] ?? window?.[legacyName] ?? window?.[aliases[name]] ?? null;
}

function sameWfoField(leftWindows, rightWindows, fields) {
  if (leftWindows.length !== rightWindows.length) return false;
  return leftWindows.every((left, index) => fields.every(field => (
    windowField(left, field) === windowField(rightWindows[index], field)
  )));
}

function wfoComparatorParity(baselineResult, candidateResult) {
  const baselineWindows = wfoBoundaryWindows(baselineResult);
  const candidateWindows = wfoBoundaryWindows(candidateResult);
  const hasWindowBoundaries = baselineWindows.length > 0 || candidateWindows.length > 0;
  const sameTrainWindows = hasWindowBoundaries
    ? sameWfoField(baselineWindows, candidateWindows, ['train_start_timestamp', 'train_end_timestamp'])
    : true;
  const sameOosWindows = hasWindowBoundaries
    ? sameWfoField(baselineWindows, candidateWindows, ['test_start_timestamp', 'test_end_timestamp'])
    : true;
  const samePurge = hasWindowBoundaries
    ? sameWfoField(baselineWindows, candidateWindows, [
      'purge_start_timestamp', 'purge_end_timestamp', 'purge_hours',
    ])
    : true;
  const sameEmbargo = hasWindowBoundaries
    ? sameWfoField(baselineWindows, candidateWindows, [
      'embargo_start_timestamp', 'embargo_end_timestamp', 'embargo_boundary_timestamp', 'embargo_hours',
    ])
    : true;
  const baselineHoldout = baselineResult?.walk_forward?.final_holdout_start_timestamp
    ?? baselineResult?.walk_forward?.final_holdout_start
    ?? null;
  const candidateHoldout = candidateResult?.walk_forward?.final_holdout_start_timestamp
    ?? candidateResult?.walk_forward?.final_holdout_start
    ?? null;
  const sameFinalHoldoutBoundary = (baselineHoldout === null && candidateHoldout === null)
    || baselineHoldout === candidateHoldout;
  return {
    same_train_windows: sameTrainWindows,
    same_oos_windows: sameOosWindows,
    same_purge: samePurge,
    same_embargo: sameEmbargo,
    same_final_holdout_boundary: sameFinalHoldoutBoundary,
    canonical_plan_hash: baselineResult?.walk_forward?.options?.canonical_plan_hash
      ?? candidateResult?.walk_forward?.options?.canonical_plan_hash
      ?? null,
  };
}

export function assertM13ComparatorParity(comparison, label = 'M1.3 comparator') {
  const contract = comparison?.common_support_comparison || {};
  const required = [
    'same_train_windows',
    'same_oos_windows',
    'same_purge',
    'same_embargo',
    'same_final_holdout_boundary',
    'common_support_outcome_independent',
  ];
  const failures = required.filter(field => contract[field] !== true);
  if (failures.length) {
    throw new Error(`${label} WFO parity failed: ${failures.join(', ')}`);
  }
  return true;
}

function selectedEventOutcomeMap(records, primaryHorizonHours) {
  const values = new Map();
  for (const record of selectedRecords(records)) {
    const id = record.independent_market_event_id || record.market_event_id;
    if (!id) continue;
    const outcome = netOutcome(record, primaryHorizonHours);
    if (outcome === null) continue;
    if (!values.has(id)) values.set(id, []);
    values.get(id).push(outcome);
  }
  return new Map([...values.entries()].map(([id, outcomes]) => [id, average(outcomes)]));
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function bootstrapEventPairs(pairs, repetitions, seed) {
  if (!pairs.length) {
    return {
      repetitions: 0,
      requested_repetitions: repetitions,
      seed,
      unit: 'independent_market_event_id',
      unit_count: 0,
      delta_expectancy_95_ci: [null, null],
      p_delta_expectancy_gt_zero: null,
      mean_delta_expectancy: null,
    };
  }
  const random = seededRandom(seed);
  const deltas = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let total = 0;
    for (let index = 0; index < pairs.length; index += 1) {
      total += pairs[Math.floor(random() * pairs.length)].delta_net_expectancy;
    }
    deltas.push(total / pairs.length);
  }
  return {
    repetitions,
    requested_repetitions: repetitions,
    seed,
    unit: 'independent_market_event_id',
    unit_count: pairs.length,
    delta_expectancy_95_ci: [round(quantile(deltas, 0.025), 8), round(quantile(deltas, 0.975), 8)],
    p_delta_expectancy_gt_zero: deltas.filter(value => value > 0).length / deltas.length,
    mean_delta_expectancy: round(average(deltas), 8),
  };
}

/** Compare two lanes on outcome-independent common OOS support. */
export function compareM13Results(baselineResult, candidateResult, {
  primaryHorizonHours = candidateResult?.candidate?.primary_horizon_hours || 8,
  repetitions = M13_BOOTSTRAP_REPETITIONS,
  seed = M13_BOOTSTRAP_SEED,
} = {}) {
  const baselineSupport = supportMap(baselineResult?.oos_records || []);
  const candidateSupport = supportMap(candidateResult?.oos_records || []);
  const commonKeys = [...baselineSupport.keys()].filter(key => candidateSupport.has(key)).sort();
  const commonEvents = new Set(commonKeys.map(key => (
    baselineSupport.get(key).independent_market_event_id
      || baselineSupport.get(key).market_event_id
  )).filter(Boolean));
  const baselineOutcomes = selectedEventOutcomeMap(baselineResult?.oos_records || [], primaryHorizonHours);
  const candidateOutcomes = selectedEventOutcomeMap(candidateResult?.oos_records || [], primaryHorizonHours);
  const baselineSelectedEvents = new Set(baselineOutcomes.keys());
  const candidateSelectedEvents = new Set(candidateOutcomes.keys());
  const pairs = [...commonEvents].sort().map(independentEventIdValue => {
    const baselineOutcome = baselineOutcomes.get(independentEventIdValue) ?? 0;
    const candidateOutcome = candidateOutcomes.get(independentEventIdValue) ?? 0;
    return {
      independent_market_event_id: independentEventIdValue,
      baseline_net_expectancy: baselineOutcome,
      candidate_net_expectancy: candidateOutcome,
      delta_net_expectancy: candidateOutcome - baselineOutcome,
      baseline_abstention_outcome_zero: baselineOutcome === 0 && !baselineSelectedEvents.has(independentEventIdValue),
      candidate_abstention_outcome_zero: candidateOutcome === 0 && !candidateSelectedEvents.has(independentEventIdValue),
    };
  });
  const baselineValues = pairs.map(pair => pair.baseline_net_expectancy);
  const candidateValues = pairs.map(pair => pair.candidate_net_expectancy);
  const deltas = pairs.map(pair => pair.delta_net_expectancy);
  const bootstrap = bootstrapEventPairs(pairs, repetitions, seed);
  const parity = wfoComparatorParity(baselineResult, candidateResult);
  return {
    common_support_record_count: commonKeys.length,
    common_support_event_count: commonEvents.size,
    paired_independent_market_events: pairs.length,
    paired_event_ids: pairs.map(pair => pair.independent_market_event_id),
    paired_event_outcomes: pairs,
    point_estimate: {
      baseline_net_expectancy_percent: round(average(baselineValues), 8),
      candidate_net_expectancy_percent: round(average(candidateValues), 8),
      delta_net_expectancy_percent: round(average(deltas), 8),
      baseline_net_profit_factor: baselineValues.length ? round(profitFactor(baselineValues), 6) : null,
      candidate_net_profit_factor: candidateValues.length ? round(profitFactor(candidateValues), 6) : null,
    },
    bootstrap,
    common_support_comparison: {
      unit: 'independent_market_event_id',
      support_key: 'timestamp|snapshot_event_id|symbol|direction',
      same_train_windows: parity.same_train_windows,
      same_oos_windows: parity.same_oos_windows,
      same_purge: parity.same_purge,
      same_embargo: parity.same_embargo,
      same_final_holdout_boundary: parity.same_final_holdout_boundary,
      canonical_plan_hash: parity.canonical_plan_hash,
      common_support_outcome_independent: true,
      abstention_outcome: 0,
      candidate_and_baseline_generated_from_same_snapshots: true,
    },
  };
}

export const compareCrossSectionalCandidates = compareM13Results;

function ciLower(comparison) {
  return finite(comparison?.bootstrap?.delta_expectancy_95_ci?.[0]);
}

function bootstrapProbability(comparison) {
  return finite(comparison?.bootstrap?.p_delta_expectancy_gt_zero);
}

/** Incremental gate: cross-sectional information must beat the frozen lane. */
export function evaluateIncrementalInformationGain({
  candidateResult,
  baselineResult,
  comparison = compareM13Results(baselineResult, candidateResult),
} = {}) {
  const failures = [];
  const commonEvents = comparison?.paired_independent_market_events || 0;
  const delta = finite(comparison?.point_estimate?.delta_net_expectancy_percent);
  const lower = ciLower(comparison);
  const probability = bootstrapProbability(comparison);
  const candidateRatio = finite(candidateResult?.stability?.positive_window_ratio) ?? 0;
  const baselineRatio = finite(baselineResult?.stability?.positive_window_ratio) ?? 0;
  const candidateConcentration = finite(candidateResult?.concentration?.max_symbol_event_share) ?? 0;
  const baselineConcentration = finite(baselineResult?.concentration?.max_symbol_event_share) ?? 0;
  if (commonEvents < M13_PROMOTION_THRESHOLDS.minimum_independent_events) failures.push('common_independent_events');
  if (delta === null || delta <= M13_PROMOTION_THRESHOLDS.minimum_delta_net_expectancy_percent) failures.push('delta_net_expectancy');
  if (lower === null || lower < M13_PROMOTION_THRESHOLDS.minimum_delta_ci_lower_percent) failures.push('delta_ci_lower');
  if (probability === null || probability < M13_PROMOTION_THRESHOLDS.minimum_probability_delta_gt_zero) failures.push('bootstrap_probability');
  if (candidateRatio < baselineRatio) failures.push('positive_window_ratio_vs_baseline');
  if (candidateConcentration > M13_PROMOTION_THRESHOLDS.maximum_symbol_event_share
    && candidateConcentration > baselineConcentration) failures.push('severe_concentration_deterioration');
  return {
    pass: failures.length === 0,
    failures,
    thresholds: {
      common_independent_events: M13_PROMOTION_THRESHOLDS.minimum_independent_events,
      delta_net_expectancy_percent: M13_PROMOTION_THRESHOLDS.minimum_delta_net_expectancy_percent,
      delta_ci_lower_percent: M13_PROMOTION_THRESHOLDS.minimum_delta_ci_lower_percent,
      bootstrap_probability_delta_gt_zero: M13_PROMOTION_THRESHOLDS.minimum_probability_delta_gt_zero,
      positive_window_ratio_vs_baseline: 'candidate >= frozen baseline',
      maximum_symbol_event_share: M13_PROMOTION_THRESHOLDS.maximum_symbol_event_share,
    },
    observed: {
      common_independent_events: commonEvents,
      delta_net_expectancy_percent: delta,
      delta_ci_lower_percent: lower,
      bootstrap_probability_delta_gt_zero: probability,
      candidate_positive_window_ratio: candidateRatio,
      baseline_positive_window_ratio: baselineRatio,
      candidate_max_symbol_event_share: candidateConcentration,
      baseline_max_symbol_event_share: baselineConcentration,
    },
    comparison,
  };
}

/** Absolute gate used only for a shadow-candidate recommendation. */
export function evaluateAbsolutePromotionGate(result = {}) {
  const metrics = result.metrics || {};
  const stability = result.stability || {};
  const failures = [];
  const observed = {
    independent_events: metrics.independent_market_events || 0,
    net_profit_factor: metrics.net_profit_factor ?? 0,
    net_expectancy_percent: metrics.net_expectancy_percent ?? 0,
    windows: stability.total_windows || 0,
    positive_windows: stability.positive_windows || 0,
    positive_window_ratio: stability.positive_window_ratio || 0,
    symbol_breadth: metrics.symbol_breadth || 0,
    calibration: metrics.score_calibration?.status || 'CALIBRATION_FAIL',
    max_symbol_event_share: result.concentration?.max_symbol_event_share ?? 0,
  };
  if (observed.independent_events < M13_PROMOTION_THRESHOLDS.minimum_independent_events) failures.push('independent_events');
  if (observed.net_profit_factor < M13_PROMOTION_THRESHOLDS.absolute_net_profit_factor) failures.push('net_profit_factor');
  if (observed.net_expectancy_percent < M13_PROMOTION_THRESHOLDS.absolute_net_expectancy_percent) failures.push('net_expectancy_percent');
  if (observed.windows < M13_PROMOTION_THRESHOLDS.absolute_windows) failures.push('windows');
  if (observed.positive_windows < M13_PROMOTION_THRESHOLDS.absolute_positive_windows) failures.push('positive_windows');
  if (observed.positive_window_ratio < M13_PROMOTION_THRESHOLDS.absolute_positive_window_ratio) failures.push('positive_window_ratio');
  if (observed.symbol_breadth < M13_PROMOTION_THRESHOLDS.absolute_symbol_breadth) failures.push('symbol_breadth');
  if (observed.calibration !== 'PASS') failures.push('calibration');
  if (observed.max_symbol_event_share > M13_PROMOTION_THRESHOLDS.maximum_symbol_event_share) failures.push('symbol_concentration');
  return {
    pass: failures.length === 0,
    failures,
    thresholds: M13_PROMOTION_THRESHOLDS,
    observed,
  };
}

function correlation(left, right) {
  const pairs = left.map((value, index) => [finite(value), finite(right[index])])
    .filter(pair => pair[0] !== null && pair[1] !== null);
  if (pairs.length < 2) return null;
  const leftMean = average(pairs.map(pair => pair[0]));
  const rightMean = average(pairs.map(pair => pair[1]));
  const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0);
  const leftDenominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) ** 2, 0));
  const rightDenominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[1] - rightMean) ** 2, 0));
  return leftDenominator && rightDenominator ? numerator / leftDenominator / rightDenominator : null;
}

/** Diagnostic factor correlations; never used to fit or select a candidate. */
export function buildFactorCorrelationDiagnostics(records = [], primaryHorizonHours = 8) {
  const fields = [
    'relative_momentum_1h', 'relative_momentum_4h', 'relative_momentum_8h', 'relative_momentum_24h',
    'residual_momentum_1h', 'residual_momentum_4h', 'residual_momentum_8h', 'residual_momentum_24h',
    'breadth_signal', 'dispersion_1h', 'dispersion_zscore', 'lead_lag_continuation',
    'lead_lag_reversal', 'relative_participation', 'derivative_rank_signal',
  ];
  const selected = selectedRecords(records);
  const outcomes = selected.map(record => netOutcome(record, primaryHorizonHours));
  return {
    diagnostic_only: true,
    outcome_used_for_diagnostic_after_selection: true,
    primary_horizon_hours: primaryHorizonHours,
    factors: Object.fromEntries(fields.map(field => [field, {
      correlation_with_primary_outcome: correlation(selected.map(record => record[field] ?? record.feature_snapshot?.[field]), outcomes),
      observations: selected.filter(record => finite(record[field] ?? record.feature_snapshot?.[field]) !== null).length,
    }])),
  };
}

export function buildM13StabilityDiagnostics(records = [], {
  primaryHorizonHours = 8,
  monthField = 'timestamp',
} = {}) {
  const selected = selectedRecords(records);
  const months = new Map();
  for (const record of selected) {
    const timestamp = timestampValue(record[monthField] ?? record.timestamp);
    if (timestamp === null) continue;
    const month = new Date(timestamp).toISOString().slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month).push(record);
  }
  const monthly = Object.fromEntries([...months.entries()].sort().map(([month, monthRecords]) => [
    month,
    summarizeM13Records(monthRecords, { primaryHorizonHours }),
  ]));
  const byRegime = Object.fromEntries(['Normal', 'High'].map(regime => [
    regime,
    summarizeM13Records(selected.filter(record => record.volatility_regime === regime), { primaryHorizonHours }),
  ]));
  return {
    diagnostic_only: true,
    monthly,
    stress_by_dispersion_regime: byRegime,
  };
}

export function summarizeM13Candidate(result, {
  baselineResult = null,
  comparatorResults = {},
  admittedDerivativeData = false,
} = {}) {
  const candidate = result?.candidate || {};
  const comparison = baselineResult ? compareM13Results(baselineResult, result) : null;
  const incremental = baselineResult ? evaluateIncrementalInformationGain({
    candidateResult: result,
    baselineResult,
    comparison,
  }) : null;
  const absolute = evaluateAbsolutePromotionGate(result);
  const evaluated = candidate.requires_derivative_admission !== true || admittedDerivativeData;
  return {
    candidate_id: result?.candidate_id || candidate.candidate_id,
    family: candidate.family || null,
    direction: 'BUY and SELL',
    primary_horizon_hours: candidate.primary_horizon_hours || 8,
    status: evaluated ? 'EVALUATED' : 'NOT_EVALUATED_DATA_NOT_ADMITTED',
    independent_generator: candidate.independent_generator === true,
    metrics: result?.metrics || null,
    all_oos_metrics: result?.all_oos_metrics || null,
    selection: result?.selection || null,
    per_window: result?.per_window || [],
    stability: result?.stability || null,
    concentration: result?.concentration || null,
    calibration: result?.calibration || null,
    incremental_gate: incremental,
    absolute_gate: absolute,
    comparison,
    comparator_results: comparatorResults,
    train_only: true,
    point_in_time_features: true,
    final_holdout_untouched: result?.final_holdout_untouched === true,
  };
}

export function decideM13({ candidateSummaries = [], bestCandidate = null } = {}) {
  const evaluated = candidateSummaries.filter(summary => summary.status === 'EVALUATED');
  const candidate = bestCandidate || evaluated.find(summary => summary.incremental_gate?.pass && summary.absolute_gate?.pass)
    || evaluated.find(summary => summary.incremental_gate?.pass)
    || evaluated[0]
    || null;
  if (!evaluated.length) return 'INSUFFICIENT_CROSS_SECTIONAL_EVIDENCE';
  if (candidate?.incremental_gate?.pass && candidate?.absolute_gate?.pass) return 'SHADOW_CANDIDATE';
  if (candidate?.incremental_gate?.pass) return 'CROSS_SECTIONAL_INFORMATION_GAIN_BUT_NOT_PROMOTABLE';
  const common = candidate?.comparison?.paired_independent_market_events || 0;
  return common < M13_PROMOTION_THRESHOLDS.minimum_independent_events
    ? 'INSUFFICIENT_CROSS_SECTIONAL_EVIDENCE'
    : 'NO_ROBUST_CROSS_SECTIONAL_ALPHA';
}

export function m13CandidateConfigHash({
  candidate,
  wfoOptions,
  symbols,
  dataAdmission = null,
  holdout = null,
  lineage = null,
} = {}) {
  return hashConfig({
    model_version: M13_MODEL_VERSION,
    feature_version: M13_FEATURE_VERSION,
    candidates: M13_PREDECLARED_CANDIDATES,
    candidate,
    wfo_options: wfoOptions,
    symbols: [...(symbols || [])].sort(),
    data_admission: dataAdmission,
    holdout_metadata: holdout,
    lineage,
  });
}

export {
  candidateSignalValue,
  grossOutcome,
  netOutcome,
  snapshotEventId,
};

// Frozen A/B observation filters. Input signals must already pass SignalEngine.
export const OBSERVATION_RULE_VERSION = 'ab-observation-v1';

function number(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(value) {
  const numeric = number(value);
  if (numeric !== null) return Number.isFinite(new Date(numeric).getTime()) ? numeric : null;
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function forSymbol(value, symbol) {
  return value && typeof value === 'object' && !(value instanceof Date) ? value[symbol] : value;
}

export function evaluateObservationCandidate(signal, { referencePrice, referenceTime } = {}) {
  const features = signal.raw_features || {};
  const close = number(features.currentPrice);
  const sma50 = number(features.sma_50);
  const volume = number(features.currentVolume);
  const volumeMA = number(features.volume_ma_20);
  const triggerTime = timestamp(signal.candle_close_time ?? signal.signal_timestamp ?? signal.timestamp);
  const quotePrice = number(forSymbol(referencePrice, signal.symbol));
  const quoteTime = timestamp(forSymbol(referenceTime, signal.symbol));
  const reasonsA = [];
  if (String(signal.signal || signal.direction || '').toUpperCase() !== 'SELL') reasonsA.push('not_sell');
  if (close === null || close <= 0 || sma50 === null || close >= sma50) reasonsA.push('trend_unconfirmed');
  if (volume === null || volumeMA === null || volumeMA <= 0 || volume / volumeMA < 1.3) reasonsA.push('volume_unconfirmed');
  if (triggerTime === null) reasonsA.push('missing_trigger_time');
  if (quoteTime !== null && triggerTime !== null && quoteTime < triggerTime) reasonsA.push('quote_before_trigger');

  const reasonsB = [...reasonsA];
  const contributors = new Set([
    signal.strategy,
    ...(signal.contributingStrategies || []),
    ...(signal.contributing_evidence || []).map(item => item.strategy),
  ]);
  const lower = number(features.donchian?.lower);
  const atr = number(features.atr_14);
  if (!contributors.has('donchian_breakout')) reasonsB.push('no_donchian_contributor');
  if (lower === null || close === null || close > lower) reasonsB.push('not_actual_breakout');
  const hasQuote = quotePrice !== null && quotePrice > 0 && quoteTime !== null
    && triggerTime !== null && quoteTime >= triggerTime;
  const extension = hasQuote && lower !== null && atr !== null && atr > 0 ? (lower - quotePrice) / atr : null;
  if (!hasQuote) reasonsB.push('quote_unavailable');
  if (extension === null || extension < 0 || extension > 0.5) reasonsB.push('outside_entry_range');
  return {
    candidates: reasonsA.length ? [] : reasonsB.length ? ['A'] : ['A', 'B'],
    rejectionReasons: { A: reasonsA, B: reasonsB },
    triggerTime: triggerTime === null ? null : new Date(triggerTime).toISOString(),
    referencePrice: hasQuote ? quotePrice : null,
    referenceTime: hasQuote ? new Date(quoteTime).toISOString() : null,
  };
}

/** B is a subset of A: return one watch-only signal with both labels, not two notices. */
export function enrichObservationSignals(signals, options = {}) {
  return signals.flatMap(signal => {
    const result = evaluateObservationCandidate(signal, options);
    if (!result.candidates.length) return [];
    const observation = {
      version: OBSERVATION_RULE_VERSION,
      candidates: result.candidates,
      trigger_time: result.triggerTime,
      reference_price: result.referencePrice,
      reference_time: result.referenceTime,
    };
    return [{
      ...signal,
      observation_only: true,
      observation_candidates: [...result.candidates],
      observation_rule_version: OBSERVATION_RULE_VERSION,
      observation_trigger_time: result.triggerTime,
      observation_reference_price: result.referencePrice,
      observation_reference_time: result.referenceTime,
      raw_features: { ...signal.raw_features, observation },
      priority: 'watch',
      priorityLabel: 'A/B observation',
      priorityDescription: 'Exploratory A/B candidate; profitability is not established.',
      priorityAction: 'watch_only',
      priorityRank: 1,
    }];
  });
}

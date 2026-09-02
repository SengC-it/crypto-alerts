// Deterministic research-only TP/SL barriers for the V2 shadow lane.
// These barriers describe an evaluation convention, not exchange execution.

import { hashConfig } from '../lineage.js';
import { rollingNatrPercent } from './canonical.js';

export const RESEARCH_BARRIER_VERSION = 'm1-research-natr-barriers-0.1.0';

export const DEFAULT_RESEARCH_BARRIER_OPTIONS = Object.freeze({
  lookbackCandles: 14,
  targetMultiple: 1.5,
  stopMultiple: 1,
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function round(value, digits = 8) {
  return Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;
}

/**
 * Build a same-rule, signal-time-only research barrier pair.
 *
 * NATR is calculated from the supplied canonical closed window, including the
 * trigger candle and never any future candle. A wider target than stop keeps
 * the convention conservative for evaluation and is not an execution claim.
 */
export function buildResearchBarriers({
  direction,
  entryPrice,
  candles = [],
  options = {},
} = {}) {
  const normalizedDirection = String(direction || '').toUpperCase();
  const entry = finite(entryPrice);
  const settings = {
    ...DEFAULT_RESEARCH_BARRIER_OPTIONS,
    ...options,
  };
  const lookbackCandles = Math.max(1, Math.floor(Number(settings.lookbackCandles)) || DEFAULT_RESEARCH_BARRIER_OPTIONS.lookbackCandles);
  const targetMultiple = finite(settings.targetMultiple);
  const stopMultiple = finite(settings.stopMultiple);
  const definition = {
    version: RESEARCH_BARRIER_VERSION,
    volatility_measure: 'rolling_true_range_percent_mean',
    lookback_candles: lookbackCandles,
    target_multiple: targetMultiple,
    stop_multiple: stopMultiple,
    research_only: true,
    execution: false,
  };
  const base = {
    ...definition,
    barrier_version: RESEARCH_BARRIER_VERSION,
    barrier_config_hash: hashConfig(definition),
    entry_price: round(entry),
    targetPrice: null,
    stopLoss: null,
    target_price: null,
    stop_loss: null,
    natr_percent: null,
    distance_percent: null,
    distance_price: null,
    source_window_start: candles[0]?.open_time ?? null,
    source_window_end: candles.at(-1)?.close_time ?? candles.at(-1)?.open_time ?? null,
    status: 'INSUFFICIENT_BARRIER_INPUT',
  };

  if (!['BUY', 'SELL'].includes(normalizedDirection)
    || entry === null
    || entry <= 0
    || targetMultiple === null
    || stopMultiple === null
    || targetMultiple <= 0
    || stopMultiple <= 0) {
    return base;
  }

  const natrPercent = rollingNatrPercent(candles, lookbackCandles);
  if (natrPercent === null || natrPercent <= 0) {
    return {
      ...base,
      direction: normalizedDirection,
      natr_percent: round(natrPercent, 6),
      status: 'INSUFFICIENT_VOLATILITY_WINDOW',
    };
  }

  const distancePercent = natrPercent * stopMultiple;
  const distancePrice = entry * distancePercent / 100;
  const targetDistance = entry * natrPercent * targetMultiple / 100;
  const targetPrice = normalizedDirection === 'BUY'
    ? entry + targetDistance
    : entry - targetDistance;
  const stopLoss = normalizedDirection === 'BUY'
    ? entry - distancePrice
    : entry + distancePrice;

  return {
    ...base,
    direction: normalizedDirection,
    natr_percent: round(natrPercent, 6),
    distance_percent: round(distancePercent, 6),
    distance_price: round(distancePrice),
    targetPrice: round(targetPrice),
    stopLoss: round(stopLoss),
    target_price: round(targetPrice),
    stop_loss: round(stopLoss),
    status: 'READY',
  };
}


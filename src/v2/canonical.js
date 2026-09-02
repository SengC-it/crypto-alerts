// M1 canonical helpers. V2 uses the M0 closed-candle and exact-window
// contract without changing the production V1 SignalEngine.

import { getIndicatorLookback, CONFIG } from '../config.js';
import {
  filterClosedCandles,
  intervalToMs,
} from '../market/candle.js';
import { computeAllIndicators } from '../indicators/index.js';
import { createIndicatorSnapshot } from '../indicators/provenance.js';

export const V2_TRIGGER_TIMEFRAME = '1h';
export const V2_CONTEXT_TIMEFRAME = '4h';

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function candleOpenTime(candle) {
  return finite(candle?.open_time ?? candle?.openTime ?? candle?.timestamp);
}

/**
 * Resolve the exact last N closed candles used by V2. The helper intentionally
 * delegates normalization and closure semantics to the M0 implementation.
 */
export function canonicalClosedWindow(candles, {
  symbol,
  timeframe = V2_TRIGGER_TIMEFRAME,
  asOf = Date.now(),
  config = CONFIG,
  lookbackCandles,
} = {}) {
  const lookback = getIndicatorLookback(config, { indicatorLookbackCandles: lookbackCandles });
  const allClosedCandles = filterClosedCandles(candles || [], {
    symbol,
    timeframe,
    now: asOf,
  });
  const indicatorCandles = allClosedCandles.slice(-lookback);
  return {
    eligible: indicatorCandles.length >= lookback,
    reason: indicatorCandles.length >= lookback ? null : 'INSUFFICIENT_CANDLE_WINDOW',
    allClosedCandles,
    candles: indicatorCandles,
    indicatorCandles,
    lookbackCandles: lookback,
    triggerCandle: allClosedCandles.at(-1) || null,
  };
}

export function canonicalIndicators(window, {
  symbol,
  timeframe = V2_TRIGGER_TIMEFRAME,
  lookbackCandles,
} = {}) {
  const candles = window?.indicatorCandles || window?.candles || [];
  const indicators = computeAllIndicators(candles);
  return createIndicatorSnapshot(indicators, {
    symbol,
    timeframe,
    candles,
    lookbackCandles: lookbackCandles ?? window?.lookbackCandles ?? candles.length,
  });
}

/**
 * Aggregate complete, aligned 1h closed candles into closed 4h context
 * candles. Incomplete groups and gaps are rejected instead of silently
 * manufacturing a higher-timeframe candle.
 */
export function aggregateClosedCandlesTo4h(candles, {
  symbol,
  asOf = Date.now(),
} = {}) {
  const source = filterClosedCandles(candles || [], {
    symbol,
    timeframe: V2_TRIGGER_TIMEFRAME,
    now: asOf,
  });
  const hour = intervalToMs('1h');
  const fourHours = intervalToMs(V2_CONTEXT_TIMEFRAME);
  const groups = new Map();

  for (const candle of source) {
    const openTime = candleOpenTime(candle);
    if (openTime === null) continue;
    const bucket = Math.floor(openTime / fourHours) * fourHours;
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push(candle);
  }

  const result = [];
  for (const [bucket, group] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...group].sort((a, b) => candleOpenTime(a) - candleOpenTime(b));
    const complete = sorted.length === 4
      && sorted.every((candle, index) => candleOpenTime(candle) === bucket + index * hour);
    if (!complete) continue;

    const first = sorted[0];
    const last = sorted.at(-1);
    result.push({
      open: first.open,
      high: Math.max(...sorted.map(candle => Number(candle.high))),
      low: Math.min(...sorted.map(candle => Number(candle.low))),
      close: last.close,
      volume: sorted.reduce((sum, candle) => sum + (Number(candle.volume) || 0), 0),
      quote_volume: sorted.every(candle => Number.isFinite(candle.quote_volume))
        ? sorted.reduce((sum, candle) => sum + candle.quote_volume, 0)
        : null,
      open_time: bucket,
      close_time: last.close_time,
      timeframe: V2_CONTEXT_TIMEFRAME,
      is_closed: true,
      symbol,
      source_candle_count: 4,
    });
  }
  // The rows are already normalized and sorted above. Preserve the explicit
  // aggregation metadata that generic normalizeCandle intentionally omits.
  return result;
}

export function candleReturnPercent(previous, current) {
  const before = finite(previous?.close);
  const after = finite(current?.close);
  if (before === null || after === null || before === 0) return null;
  return ((after - before) / before) * 100;
}

export function mean(values) {
  const numbers = (values || []).map(Number).filter(Number.isFinite);
  return numbers.length ? numbers.reduce((sum, value) => sum + value, 0) / numbers.length : null;
}

export function standardDeviation(values) {
  const average = mean(values);
  if (average === null) return null;
  const numbers = values.map(Number).filter(Number.isFinite);
  return numbers.length ? Math.sqrt(mean(numbers.map(value => (value - average) ** 2))) : null;
}

export function median(values) {
  const numbers = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2 ? numbers[middle] : (numbers[middle - 1] + numbers[middle]) / 2;
}

export function quantile(values, probability) {
  const numbers = (values || []).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!numbers.length) return null;
  const position = (numbers.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return numbers[lower];
  return numbers[lower] + (numbers[upper] - numbers[lower]) * (position - lower);
}

export function trueRangePercent(candle, previousCandle) {
  const high = finite(candle?.high);
  const low = finite(candle?.low);
  const close = finite(candle?.close);
  const previousClose = finite(previousCandle?.close) ?? close;
  if ([high, low, close, previousClose].some(value => value === null) || previousClose === 0) return null;
  const trueRange = Math.max(high - low, Math.abs(high - previousClose), Math.abs(low - previousClose));
  return trueRange / Math.abs(previousClose) * 100;
}

export function rollingNatrPercent(candles, lookback = 14) {
  const source = candles || [];
  if (source.length < lookback + 1) return null;
  const values = [];
  for (let index = source.length - lookback; index < source.length; index++) {
    const value = trueRangePercent(source[index], source[index - 1]);
    if (value !== null) values.push(value);
  }
  return values.length === lookback ? mean(values) : null;
}

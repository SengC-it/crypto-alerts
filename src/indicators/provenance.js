import { hashConfig } from '../lineage.js';

export const INDICATOR_ENGINE_VERSION = 'm0.2-canonical-window';
export const INDICATOR_PROVENANCE = Symbol.for('crypto-alerts.indicator-provenance');

function candleFingerprint(candle) {
  return {
    open: candle.open,
    high: candle.high,
    low: candle.low,
    close: candle.close,
    volume: candle.volume,
    open_time: candle.open_time,
    close_time: candle.close_time,
    timeframe: candle.timeframe,
    is_closed: candle.is_closed,
    symbol: candle.symbol,
  };
}

export function indicatorConfigHash({ timeframe = '1h', lookbackCandles }) {
  return hashConfig({
    indicator_engine_version: INDICATOR_ENGINE_VERSION,
    timeframe,
    indicator_lookback_candles: lookbackCandles,
  });
}

export function indicatorWindowHash(candles) {
  return hashConfig((candles || []).map(candleFingerprint));
}

/**
 * Attach non-enumerable provenance to a snapshot so persisted indicator data
 * remains backward-compatible while the SignalEngine can reject unverified
 * precomputed values.
 */
export function createIndicatorSnapshot(indicators, {
  symbol,
  timeframe = '1h',
  candles = [],
  lookbackCandles,
} = {}) {
  if (!indicators || typeof indicators !== 'object') return null;

  const window = candles.slice(-lookbackCandles);
  const first = window[0];
  const last = window.at(-1);
  const snapshot = { ...indicators };
  const provenance = {
    symbol,
    timeframe,
    lookback_candles: lookbackCandles,
    candle_count: window.length,
    window_start_open_time: first?.open_time ?? null,
    window_end_open_time: last?.open_time ?? null,
    candle_open_time: last?.open_time ?? null,
    candle_close_time: last?.close_time ?? null,
    window_hash: indicatorWindowHash(window),
    indicator_config_hash: indicatorConfigHash({ timeframe, lookbackCandles }),
  };

  Object.defineProperty(snapshot, INDICATOR_PROVENANCE, {
    value: provenance,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return snapshot;
}

export function getIndicatorProvenance(indicators) {
  return indicators?.[INDICATOR_PROVENANCE] || null;
}

export function isIndicatorSnapshotForWindow(indicators, {
  symbol,
  timeframe = '1h',
  candles = [],
  lookbackCandles,
} = {}) {
  const provenance = getIndicatorProvenance(indicators);
  if (!provenance || !Number.isInteger(lookbackCandles)) return false;

  const window = candles.slice(-lookbackCandles);
  const last = window.at(-1);
  return provenance.symbol === symbol
    && provenance.timeframe === timeframe
    && provenance.lookback_candles === lookbackCandles
    && provenance.candle_count === window.length
    && provenance.window_start_open_time === (window[0]?.open_time ?? null)
    && provenance.window_end_open_time === (last?.open_time ?? null)
    && provenance.candle_open_time === (last?.open_time ?? null)
    && provenance.candle_close_time === (last?.close_time ?? null)
    && provenance.window_hash === indicatorWindowHash(window)
    && provenance.indicator_config_hash === indicatorConfigHash({ timeframe, lookbackCandles });
}

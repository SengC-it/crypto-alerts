// Canonical candle abstraction shared by live, serverless and backtest paths.

const INTERVAL_MS = {
  '1m': 60 * 1000,
  '3m': 3 * 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '2h': 2 * 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '6h': 6 * 60 * 60 * 1000,
  '8h': 8 * 60 * 60 * 1000,
  '12h': 12 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
  '3d': 3 * 24 * 60 * 60 * 1000,
  '1w': 7 * 24 * 60 * 60 * 1000,
};

export function intervalToMs(timeframe = '1h') {
  const value = INTERVAL_MS[timeframe];
  if (!value) throw new Error(`Unsupported timeframe: ${timeframe}`);
  return value;
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDefined(...values) {
  return values.find(value => value !== undefined && value !== null);
}

function booleanValue(value) {
  if (typeof value === 'string') {
    return !['false', '0', 'no', 'open', 'unfinished'].includes(value.toLowerCase());
  }
  return Boolean(value);
}

/**
 * Convert a Binance kline array or an object from any ingestion path into the
 * one candle shape used by the application.
 */
export function normalizeCandle(input, options = {}) {
  if (!input) throw new Error('Candle is required');

  const timeframe = options.timeframe || input.timeframe || input.interval || '1h';
  const step = intervalToMs(timeframe);
  const symbol = options.symbol || input.symbol || '';
  const now = options.now ?? Date.now();
  const isArray = Array.isArray(input);

  const openTimeValue = isArray
    ? input[0]
    : firstDefined(input.open_time, input.openTime, input.startTime, input.timestamp);
  const closeTimeValue = isArray
    ? input[6]
    : firstDefined(input.close_time, input.closeTime, input.endTime, input.timestamp);

  const closeTime = numberOrNull(closeTimeValue);
  const openTime = numberOrNull(openTimeValue) ?? (closeTime === null ? null : closeTime - step + 1);
  const explicitClosed = firstDefined(options.isClosed, input.is_closed, input.isClosed);
  const closedByTime = closeTime === null || closeTime <= now;
  const isClosed = explicitClosed === undefined
    ? closedByTime
    : booleanValue(explicitClosed) && closedByTime;

  const candle = {
    open: numberOrNull(isArray ? input[1] : input.open),
    high: numberOrNull(isArray ? input[2] : input.high),
    low: numberOrNull(isArray ? input[3] : input.low),
    close: numberOrNull(isArray ? input[4] : input.close),
    volume: numberOrNull(isArray ? input[5] : input.volume),
    open_time: openTime,
    close_time: closeTime ?? (openTime === null ? null : openTime + step - 1),
    timeframe,
    is_closed: isClosed,
    symbol,
  };

  // Keep the old timestamp field as a compatibility alias. It is always the
  // candle close time, never the processing wall clock.
  candle.timestamp = candle.close_time;

  if (isArray) {
    candle.quote_volume = numberOrNull(input[7]);
    candle.trade_count = numberOrNull(input[8]);
    candle.taker_buy_volume = numberOrNull(input[9]);
    candle.taker_buy_quote_volume = numberOrNull(input[10]);
  }

  return candle;
}

export function isValidCandle(candle) {
  return Boolean(
    candle
    && Number.isFinite(candle.open)
    && Number.isFinite(candle.high)
    && Number.isFinite(candle.low)
    && Number.isFinite(candle.close)
    && Number.isFinite(candle.volume)
    && (candle.open_time === null || Number.isFinite(candle.open_time))
    && (candle.close_time === null || Number.isFinite(candle.close_time))
  );
}

/** Normalize, remove invalid rows, sort and de-duplicate by open time. */
export function normalizeCandles(candles, options = {}) {
  if (!Array.isArray(candles)) return [];

  const normalized = candles
    .map(candle => normalizeCandle(candle, options))
    .filter(isValidCandle)
    .sort((a, b) => (a.open_time ?? a.close_time ?? 0) - (b.open_time ?? b.close_time ?? 0));

  const unique = [];
  const seen = new Set();
  for (const candle of normalized) {
    const key = candle.open_time ?? `${candle.close_time}:${candle.close}`;
    if (seen.has(key)) {
      unique[unique.length - 1] = candle;
    } else {
      seen.add(key);
      unique.push(candle);
    }
  }
  return unique;
}

/**
 * Only closed candles at or before the requested as-of time may reach the
 * primary signal engine. An explicit false always wins; an explicit true
 * cannot turn a future candle into an eligible candle.
 */
export function filterClosedCandles(candles, options = {}) {
  return normalizeCandles(candles, options).filter(candle => candle.is_closed === true);
}

export function assertClosedCandle(candle) {
  if (!candle || candle.is_closed !== true) {
    throw new Error('Primary signals require a closed candle');
  }
  return candle;
}

export function candleTime(candle) {
  return candle?.close_time ?? candle?.timestamp ?? candle?.open_time ?? null;
}

export function candleToIso(value) {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

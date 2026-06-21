import { getCandles } from '../websocket/rest.js';

const INTERVAL_MS = {
  '1m': 60 * 1000,
  '5m': 5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h': 60 * 60 * 1000,
  '4h': 4 * 60 * 60 * 1000,
  '1d': 24 * 60 * 60 * 1000,
};

function sleep(ms) {
  return ms > 0 ? new Promise(resolve => setTimeout(resolve, ms)) : Promise.resolve();
}

function normalizeKline(row) {
  return {
    openTime: Number(row[0]),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
    closeTime: Number(row[6]),
  };
}

async function fetchPageWithRetry(getCandlesFn, symbol, interval, limit, params, maxRetries, retryDelayMs) {
  let lastError;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const payload = await getCandlesFn(symbol, interval, limit, params);
      if (!Array.isArray(payload)) {
        throw new Error(`Invalid candle payload for ${symbol}: ${JSON.stringify(payload).slice(0, 300)}`);
      }
      return payload;
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries) await sleep(retryDelayMs);
    }
  }
  throw lastError;
}

export async function fetchHistoricalCandles(options) {
  const {
    symbol,
    interval = '1h',
    candlesNeeded,
    pageLimit = 1500,
    now = Date.now(),
    getCandlesFn = getCandles,
    maxRetries = 2,
    retryDelayMs = 500,
  } = options;

  if (!symbol) throw new Error('fetchHistoricalCandles requires symbol');
  if (!candlesNeeded || candlesNeeded <= 0) throw new Error('fetchHistoricalCandles requires candlesNeeded > 0');

  const intervalMs = INTERVAL_MS[interval];
  if (!intervalMs) throw new Error(`Unsupported interval: ${interval}`);

  const byOpenTime = new Map();
  let endTime = now;
  let keepFetching = true;

  while (byOpenTime.size < candlesNeeded && keepFetching) {
    const limit = Math.min(pageLimit, candlesNeeded - byOpenTime.size);
    const page = await fetchPageWithRetry(
      getCandlesFn,
      symbol,
      interval,
      limit,
      { endTime },
      maxRetries,
      retryDelayMs
    );

    if (page.length === 0) break;

    const normalized = page.map(normalizeKline).filter(c => Number.isFinite(c.openTime));
    for (const candle of normalized) byOpenTime.set(candle.openTime, candle);

    const earliest = Math.min(...normalized.map(c => c.openTime));
    const nextEndTime = earliest - 1;
    keepFetching = Number.isFinite(nextEndTime) && nextEndTime < endTime;
    endTime = nextEndTime;

    if (page.length < limit) break;
  }

  const candles = [...byOpenTime.values()].sort((a, b) => a.openTime - b.openTime);
  if (candles.length < candlesNeeded) {
    throw new Error(`Insufficient historical data for ${symbol}: needed ${candlesNeeded}, got ${candles.length}`);
  }

  return candles.slice(-candlesNeeded);
}

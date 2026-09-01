// Binance Futures REST API Client
// 支持 HTTP/SOCKS 代理（国内访问 Binance 需要）

import https from 'node:https';
import { CONFIG } from '../config.js';
import { getProxyUrl, requestViaProxy } from './proxy.js';
import { intervalToMs } from '../market/candle.js';

const { BINANCE } = CONFIG;

/**
 * GET request to Binance Futures API (auto proxy detection)
 */
async function get(path, params = {}) {
  const urlObj = new URL(path, BINANCE.REST_URL);
  Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .forEach(([k, v]) => urlObj.searchParams.set(k, String(v)));
  const fullUrl = urlObj.toString();
  const proxyUrl = getProxyUrl();

  // 如果有代理，走代理隧道
  if (proxyUrl) {
    return requestViaProxy(fullUrl, proxyUrl);
  }

  // 无代理，直连
  return new Promise((resolve, reject) => {
    const req = https.get(fullUrl, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
  });
}

/**
 * Get K-line / Candlestick data
 */
export async function getCandles(symbol, interval = '1h', limit = 100, extraParams = {}) {
  return get('/fapi/v1/klines', { symbol, interval, limit, ...extraParams });
}

function candleOpenTime(row) {
  if (Array.isArray(row)) return Number(row[0]);
  return Number(row?.open_time ?? row?.openTime ?? row?.startTime ?? row?.timestamp);
}

/**
 * Fetch a complete historical range page by page. Binance limits each kline
 * response, so the cursor advances from the last returned candle.
 */
export async function getHistoricalCandles(symbol, interval = '1h', options = {}) {
  const {
    startTime,
    endTime,
    pageLimit = 1500,
    maxPages = 1000,
    fetchPage,
  } = options;
  const limit = Math.min(1500, Math.max(1, Number(pageLimit) || 1500));

  if (startTime === undefined && endTime === undefined) {
    return getCandles(symbol, interval, limit);
  }

  const step = intervalToMs(interval);
  const rows = [];
  const seen = new Set();
  let cursor = startTime;

  for (let pageNumber = 0; pageNumber < maxPages; pageNumber++) {
    const request = {
      symbol,
      interval,
      limit,
      startTime: cursor,
      endTime,
    };
    const page = await (fetchPage
      ? fetchPage(request)
      : getCandles(symbol, interval, limit, { startTime: cursor, endTime }));
    const batch = Array.isArray(page) ? page : [];
    if (batch.length === 0) break;

    let lastOpenTime = null;
    for (const row of batch) {
      const openTime = candleOpenTime(row);
      if (!Number.isFinite(openTime)) continue;
      lastOpenTime = openTime;
      if (!seen.has(openTime)) {
        seen.add(openTime);
        rows.push(row);
      }
    }

    if (lastOpenTime === null) break;
    const nextCursor = lastOpenTime + step;
    if (cursor !== undefined && nextCursor <= cursor) break;
    cursor = nextCursor;
    if (batch.length < limit) break;
    if (endTime !== undefined && cursor > endTime) break;
  }

  return rows.sort((a, b) => candleOpenTime(a) - candleOpenTime(b));
}

/**
 * Get latest price
 */
export async function getPrice(symbol) {
  return get('/fapi/v1/ticker/price', { symbol });
}

/**
 * Get 24hr ticker statistics
 */
export async function get24hTicker(symbol) {
  return get('/fapi/v1/ticker/24hr', { symbol });
}

/**
 * Get exchange info
 */
export async function getExchangeInfo() {
  return get('/fapi/v1/exchangeInfo');
}

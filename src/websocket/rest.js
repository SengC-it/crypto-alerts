// Binance Futures REST API Client
// 支持 HTTP/SOCKS 代理（国内访问 Binance 需要）

import https from 'node:https';
import { CONFIG } from '../config.js';
import { getProxyUrl, requestViaProxy } from './proxy.js';

const { BINANCE } = CONFIG;

/**
 * GET request to Binance Futures API (auto proxy detection)
 */
async function get(path, params = {}) {
  const urlObj = new URL(path, BINANCE.REST_URL);
  Object.entries(params).forEach(([k, v]) => urlObj.searchParams.set(k, String(v)));
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
export async function getCandles(symbol, interval = '1h', limit = 100) {
  return get('/fapi/v1/klines', { symbol, interval, limit });
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

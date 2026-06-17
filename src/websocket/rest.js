// Binance Futures REST API Client

import http from 'node:http';
import https from 'node:https';
import { CONFIG } from '../config.js';

const { BINANCE } = CONFIG;

/**
 * GET request to Binance Futures API
 */
async function get(path, params = {}) {
  const urlObj = new URL(path, BINANCE.REST_URL);
  Object.entries(params).forEach(([k, v]) => urlObj.searchParams.set(k, String(v)));

  return new Promise((resolve, reject) => {
    const req = https.get(urlObj.toString(), (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Invalid JSON: ' + data)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('Request timeout')); });
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

// Binance Futures REST API Client
// 支持 HTTP/SOCKS 代理（国内访问 Binance 需要）

import https from 'node:https';
import http from 'node:http';
import { CONFIG } from '../config.js';

const { BINANCE } = CONFIG;

/**
 * 解析代理地址，优先 HTTPS_PROXY / HTTP_PROXY / .env 中配置
 */
function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || null;
}

/**
 * 通过 HTTP 代理发送 CONNECT 隧道请求
 */
function requestViaProxy(targetUrl, proxyUrl) {
  const proxyParsed = new URL(proxyUrl);
  const targetParsed = new URL(targetUrl);

  const proxyPort = parseInt(proxyParsed.port) || (proxyParsed.protocol === 'https:' ? 443 : 80);
  const proxyHost = proxyParsed.hostname;

  const targetHost = targetParsed.hostname;
  const targetPort = targetParsed.port || (targetParsed.protocol === 'https:' ? 443 : 80);

  return new Promise((resolve, reject) => {
    const connectOpts = {
      host: proxyHost,
      port: proxyPort,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
    };

    if (proxyParsed.username || proxyParsed.password) {
      const auth = Buffer.from(`${proxyParsed.username}:${proxyParsed.password}`).toString('base64');
      connectOpts.headers = { 'Proxy-Authorization': `Basic ${auth}` };
    }

    const connectReq = http.request(connectOpts);

    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        reject(new Error(`Proxy CONNECT failed: ${res.statusCode}`));
        return;
      }

      const reqOpts = {
        host: targetHost,
        port: targetPort,
        path: targetParsed.pathname + targetParsed.search,
        method: 'GET',
        socket: socket,
        agent: false,
      };

      const req = https.request(reqOpts, (apiRes) => {
        let data = '';
        apiRes.on('data', (chunk) => (data += chunk));
        apiRes.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { reject(new Error('Invalid JSON: ' + data.substring(0, 200))); }
        });
      });

      req.on('error', reject);
      req.setTimeout(15000, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });

    connectReq.on('error', reject);
    connectReq.setTimeout(10000, () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });
    connectReq.end();
  });
}

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

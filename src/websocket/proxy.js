// HTTP Proxy Utilities
// 共享代理隧道逻辑，供 rest.js 和 binance.js 使用

import http from 'node:http';
import https from 'node:https';

/**
 * 解析代理地址，优先 HTTPS_PROXY / HTTP_PROXY / .env 中配置
 */
export function getProxyUrl() {
  return process.env.HTTPS_PROXY || process.env.https_proxy
    || process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy
    || null;
}

/**
 * 通过 HTTP 代理发送 CONNECT 隧道请求
 * @param {string} targetUrl - 目标 URL
 * @param {string} proxyUrl - 代理 URL
 * @returns {Promise<net.Socket>} - 已建立的隧道 socket
 */
export function connectViaProxy(targetUrl, proxyUrl) {
  const proxyParsed = new URL(proxyUrl);
  const targetParsed = new URL(targetUrl);

  const proxyPort = parseInt(proxyParsed.port) || (proxyParsed.protocol === 'https:' ? 443 : 80);
  const proxyHost = proxyParsed.hostname;
  const targetHost = targetParsed.hostname;
  const targetPort = targetParsed.port || (targetParsed.protocol === 'https:' || targetParsed.protocol === 'wss:' ? 443 : 80);

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
      resolve(socket);
    });

    connectReq.on('error', reject);
    connectReq.setTimeout(10000, () => { connectReq.destroy(); reject(new Error('Proxy connect timeout')); });
    connectReq.end();
  });
}

/**
 * 通过代理隧道发送 HTTPS GET 请求并解析 JSON 响应
 * @param {string} targetUrl - 目标完整 URL
 * @param {string} proxyUrl - 代理 URL
 * @param {number} [timeout=15000] - 请求超时毫秒
 * @returns {Promise<object>} - 解析后的 JSON 数据
 */
export function requestViaProxy(targetUrl, proxyUrl, timeout = 15000) {
  const targetParsed = new URL(targetUrl);
  const targetHost = targetParsed.hostname;
  const targetPort = targetParsed.port || (targetParsed.protocol === 'https:' ? 443 : 80);
  const targetPath = targetParsed.pathname + targetParsed.search;

  return connectViaProxy(targetUrl, proxyUrl).then(socket => {
    return new Promise((resolve, reject) => {
      const reqOpts = {
        host: targetHost,
        port: targetPort,
        path: targetPath,
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
      req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Request timeout')); });
      req.end();
    });
  });
}

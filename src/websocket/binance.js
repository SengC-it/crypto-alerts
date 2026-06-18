// Binance Futures WebSocket Client
// 使用组合流 (Combined Stream) 稳定订阅多个币种

import WebSocket from 'ws';
import https from 'node:https';
import { CONFIG } from '../config.js';
import { getCandles } from './rest.js';
import { getProxyUrl, connectViaProxy } from './proxy.js';

const { BINANCE } = CONFIG;

/**
 * 构建组合流 URL
 * 格式: wss://fstream.binance.com/stream?streams=stream1/stream2/...
 */
function buildCombinedStreamUrl() {
  const streams = [];
  for (const [tierKey, tier] of Object.entries(CONFIG.MONITOR_TIERS)) {
    // Tier1 使用 15m K线以匹配其 15 分钟检查间隔，其余使用 1h
    const interval = tierKey === 'tier1' ? '15m' : '1h';
    for (const symbol of tier.symbols) {
      streams.push(`${symbol.toLowerCase()}@kline_${interval}`);
    }
  }
  // 去重（避免同一币种出现在多档时重复订阅）
  const uniqueStreams = [...new Set(streams)];
  const streamPath = uniqueStreams.join('/');
  return `wss://fstream.binance.com/stream?streams=${streamPath}`;
}

class BinanceFuturesWS {
  constructor() {
    this.ws = null;
    this.reconnectInterval = 15000;
    this.maxReconnectInterval = 60000;
    this.reconnectTimer = null;
    this.klineListeners = new Map();
    this.tickerListeners = new Map();
    this.isReady = false;
    this.cachedCandles = new Map();  // symbol -> last known candles
    this._intentionalClose = false;
  }

  /**
   * Connect to Binance Futures WebSocket (Combined Stream)
   */
  async connect() {
    this._intentionalClose = false;
    const combinedUrl = buildCombinedStreamUrl();
    const proxyUrl = getProxyUrl();

    let wsOptions = {};
    if (proxyUrl) {
      console.log('[WS] Using proxy:', proxyUrl);
      try {
        const socket = await connectViaProxy(combinedUrl, proxyUrl);
        wsOptions = { agent: new https.Agent({ socket, rejectUnauthorized: false }) };
      } catch (err) {
        console.warn('[WS] Proxy tunnel failed, trying direct:', err.message);
      }
    }

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(combinedUrl, wsOptions);

      const connectTimeout = setTimeout(() => {
        this.ws.terminate();
        reject(new Error('WebSocket connect timeout'));
      }, 30000);

      this.ws.on('open', () => {
        clearTimeout(connectTimeout);
        console.log('[WS] Connected to Binance Futures Combined Stream');
        console.log('[WS] Monitoring', CONFIG.BINANCE_SYMBOLS.length, 'symbols');
        this.isReady = true;
        this.reconnectInterval = 15000;  // reset backoff on success
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const wrapped = JSON.parse(data.toString());
          // Combined stream format: { stream: "btcusdt@kline_1h", data: {...} }
          if (wrapped.data) {
            this.handleMessage(wrapped.data);
          }
        } catch (e) {
          // ignore non-JSON
        }
      });

      this.ws.on('close', () => {
        clearTimeout(connectTimeout);
        this.isReady = false;
        if (!this._intentionalClose) {
          console.log('[WS] Disconnected. Reconnecting in', this.reconnectInterval / 1000, 's...');
          this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectInterval);
          // Exponential backoff
          this.reconnectInterval = Math.min(this.reconnectInterval * 1.5, this.maxReconnectInterval);
        }
      });

      this.ws.on('error', (err) => {
        clearTimeout(connectTimeout);
        console.error('[WS] Error:', err.message);
        reject(err);
      });

      // Ping/Pong keep-alive
      this.ws.on('ping', () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.pong();
        }
      });
    });
  }

  handleMessage(msg) {
    // Kline message
    if (msg.e === 'kline') {
      const symbol = msg.s;
      const kline = msg.k;

      if (kline.x) {  // Closed candle - trigger analysis
        const candle = {
          open: parseFloat(kline.o),
          high: parseFloat(kline.h),
          low: parseFloat(kline.l),
          close: parseFloat(kline.c),
          volume: parseFloat(kline.v),
          timestamp: kline.T,
        };

        // Update cached candles
        if (!this.cachedCandles.has(symbol)) {
          this.cachedCandles.set(symbol, []);
        }
        const candles = this.cachedCandles.get(symbol);
        candles.push(candle);
        if (candles.length > 100) candles.shift();  // Keep last 100

        // Notify listeners
        const listeners = this.klineListeners.get(symbol);
        if (listeners) {
          for (const fn of listeners) {
            fn(candle, candles);
          }
        }
      }
    }
  }

  /**
   * Listen for kline events
   */
  onKline(symbol, callback) {
    if (!this.klineListeners.has(symbol)) {
      this.klineListeners.set(symbol, []);
    }
    this.klineListeners.get(symbol).push(callback);
  }

  /**
   * Listen for ticker events
   */
  onTicker(symbol, callback) {
    if (!this.tickerListeners.has(symbol)) {
      this.tickerListeners.set(symbol, []);
    }
    this.tickerListeners.get(symbol).push(callback);
  }

  /**
   * Fetch historical candles to warm up the cache
   */
  async warmUpCache() {
    console.log('[WS] Warming up candle cache...');

    // 收集每个币种对应的 K 线间隔
    const symbolIntervals = new Map();  // symbol -> interval
    for (const [tierKey, tier] of Object.entries(CONFIG.MONITOR_TIERS)) {
      const interval = tierKey === 'tier1' ? '15m' : '1h';
      for (const symbol of tier.symbols) {
        if (!symbolIntervals.has(symbol)) {
          symbolIntervals.set(symbol, interval);
        }
      }
    }

    // Parallel fetch in batches of 5 to avoid rate limits
    const batchSize = 5;
    const symbols = [...symbolIntervals.keys()];
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          const interval = symbolIntervals.get(symbol);
          const candles = await getCandles(symbol, interval, 100);
          const parsed = candles.map((c) => ({
            open: parseFloat(c[1]),
            high: parseFloat(c[2]),
            low: parseFloat(c[3]),
            close: parseFloat(c[4]),
            volume: parseFloat(c[5]),
            timestamp: c[6],
          }));
          this.cachedCandles.set(symbol, parsed);
          console.log('[WS] Cached', parsed.length, `${interval} candles for`, symbol);
        })
      );

      for (let j = 0; j < results.length; j++) {
        if (results[j].status === 'rejected') {
          console.warn('[WS] Failed to warm up', batch[j], ':', results[j].reason?.message);
        }
      }
    }
  }

  close() {
    this._intentionalClose = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    console.log('[WS] Closed');
  }
}

export const wsClient = new BinanceFuturesWS();

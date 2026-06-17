// Binance Futures WebSocket Client

import WebSocket from 'ws';
import { CONFIG } from '../config.js';
import { getCandles } from './rest.js';

const { BINANCE } = CONFIG;

class BinanceFuturesWS {
  constructor() {
    this.ws = null;
    this.reconnectInterval = 10000;
    this.reconnectTimer = null;
    this.klineListeners = new Map();
    this.tickerListeners = new Map();
    this.isReady = false;
    this.cachedCandles = new Map();  // symbol -> last known candles
  }

  /**
   * Connect to Binance Futures WebSocket
   */
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(BINANCE.WS_URL);

      this.ws.on('open', () => {
        console.log('[WS] Connected to Binance Futures WebSocket');
        this.subscribeAll();
        this.isReady = true;
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const msg = JSON.parse(data.toString());
          this.handleMessage(msg);
        } catch (e) {
          // ignore
        }
      });

      this.ws.on('close', () => {
        console.log('[WS] Disconnected. Reconnecting...');
        this.isReady = false;
        this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectInterval);
      });

      this.ws.on('error', (err) => {
        console.error('[WS] Error:', err.message);
        reject(err);
      });
    });
  }

  subscribeAll() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    // Subscribe to kline streams for all monitored symbols
    for (const symbol of BINANCE.SYMBOLS) {
      const stream = symbol.toLowerCase() + '@kline_1h';
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: [stream],
        id: Date.now() + Math.random(),
      }));
      console.log('[WS] Subscribed to', stream);
    }

    // Also subscribe to tickers for quick price
    for (const symbol of BINANCE.SYMBOLS) {
      const stream = symbol.toLowerCase() + '@ticker';
      this.ws.send(JSON.stringify({
        method: 'SUBSCRIBE',
        params: [stream],
        id: Date.now() + Math.random(),
      }));
      console.log('[WS] Subscribed to', stream);
    }
  }

  handleMessage(msg) {
    // Kline message
    if (msg.e === 'kline') {
      const symbol = msg.s;
      const kline = msg.k;

      if (kline.x) {  // Closed candle - this is where we trigger analysis
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

    // Ticker message (quick price update)
    if (msg.e === '24hrTicker') {
      const symbol = msg.s;
      const price = parseFloat(msg.c);
      const listeners = this.tickerListeners.get(symbol);
      if (listeners) {
        for (const fn of listeners) {
          fn({ symbol, price, volume: parseFloat(msg.v), change: parseFloat(msg.P) });
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
    for (const symbol of BINANCE.SYMBOLS) {
      try {
        const candles = await getCandles(symbol, '1h', 100);
        const parsed = candles.map((c) => ({
          open: parseFloat(c[1]),
          high: parseFloat(c[2]),
          low: parseFloat(c[3]),
          close: parseFloat(c[4]),
          volume: parseFloat(c[5]),
          timestamp: c[6],
        }));
        this.cachedCandles.set(symbol, parsed);
        console.log('[WS] Cached', parsed.length, 'candles for', symbol);
      } catch (err) {
        console.warn('[WS] Failed to warm up', symbol, ':', err.message);
      }
    }
  }

  close() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) this.ws.close();
    console.log('[WS] Closed');
  }
}

export const wsClient = new BinanceFuturesWS();

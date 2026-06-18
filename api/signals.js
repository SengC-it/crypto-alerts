// Vercel Serverless API - 获取最近的信号记录
// GET /api/signals?symbol=BTCUSDT&limit=20

import { signalStore } from '../../src/db/signalStore.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { symbol, limit } = req.query;
  const limitNum = Math.min(parseInt(limit) || 20, 100);

  try {
    if (symbol) {
      const signals = await signalStore.getRecentSignals(symbol.toUpperCase(), limitNum);
      return res.status(200).json({ symbol, signals });
    }

    // 没有指定 symbol，返回所有监控交易对
    const { CONFIG } = await import('../../src/config.js');
    const allSignals = {};
    for (const sym of CONFIG.BINANCE_SYMBOLS) {
      allSignals[sym] = await signalStore.getRecentSignals(sym, 5);
    }
    return res.status(200).json({ signals: allSignals });
  } catch (err) {
    console.error('[API] Fetch signals failed:', err);
    return res.status(500).json({ error: err.message });
  }
}

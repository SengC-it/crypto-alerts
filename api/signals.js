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

    // 没有指定 symbol，返回所有监控交易对（并行查询）
    const { CONFIG } = await import('../../src/config.js');
    const symbols = CONFIG.BINANCE_SYMBOLS;
    const results = await Promise.allSettled(
      symbols.map(async (sym) => {
        const data = await signalStore.getRecentSignals(sym, 5);
        return [sym, data];
      })
    );
    const allSignals = {};
    for (const r of results) {
      if (r.status === 'fulfilled') {
        allSignals[r.value[0]] = r.value[1];
      }
    }
    return res.status(200).json({ signals: allSignals });
  } catch (err) {
    console.error('[API] Fetch signals failed:', err);
    return res.status(500).json({ error: err.message });
  }
}

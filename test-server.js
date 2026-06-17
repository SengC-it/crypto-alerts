// 本地测试用 HTTP 服务器（模拟 Vercel API）
// 用法: node test-server.js

import http from 'node:http';
import { checkAllSignals, checkSymbol } from './api/lib/checker.js';
import { signalStore } from './src/db/signalStore.js';
import { CONFIG } from './src/config.js';

const PORT = 3000;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');

  try {
    // GET /api/health
    if (path === '/api/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString(), version: '1.0.0' }));
    }

    // GET /api/check
    else if (path === '/api/check') {
      console.log('[Server] Running signal check...');
      const result = await checkAllSignals();
      res.writeHead(200);
      res.end(JSON.stringify(result));
    }

    // GET /api/check/BTCUSDT
    else if (path.startsWith('/api/check/')) {
      const symbol = path.split('/').pop().toUpperCase();
      console.log(`[Server] Checking ${symbol}...`);
      const result = await checkSymbol(symbol);
      res.writeHead(200);
      res.end(JSON.stringify(result));
    }

    // GET /api/signals?symbol=BTCUSDT&limit=10
    else if (path === '/api/signals') {
      const symbol = url.searchParams.get('symbol');
      const limit = parseInt(url.searchParams.get('limit')) || 20;
      const limitNum = Math.min(limit, 100);

      if (symbol) {
        const signals = await signalStore.getRecentSignals(symbol.toUpperCase(), limitNum);
        res.writeHead(200);
        res.end(JSON.stringify({ symbol, signals }));
      } else {
        const allSignals = {};
        for (const sym of CONFIG.BINANCE.SYMBOLS) {
          allSignals[sym] = await signalStore.getRecentSignals(sym, 5);
        }
        res.writeHead(200);
        res.end(JSON.stringify({ signals: allSignals }));
      }
    }

    // 404
    else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'Not found', endpoints: ['/api/health', '/api/check', '/api/check/:symbol', '/api/signals'] }));
    }
  } catch (err) {
    console.error('[Server] Error:', err.message);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, () => {
  console.log('');
  console.log('  Crypto Alerts - Local Test Server');
  console.log(`  http://localhost:${PORT}`);
  console.log('');
  console.log('  Endpoints:');
  console.log(`  GET /api/health         - Health check`);
  console.log(`  GET /api/check          - Check all signals`);
  console.log(`  GET /api/check/BTCUSDT  - Check single pair`);
  console.log(`  GET /api/signals        - Get signal history`);
  console.log('');
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { fetchHistoricalCandles } from '../src/backtest/historicalData.js';

function kline(openTime, close = 100) {
  return [openTime, '99', '101', '98', String(close), '1000', openTime + 3599999];
}

describe('Historical data fetching', () => {
  it('fetches paginated candles backward, deduplicates, and returns chronological rows', async () => {
    const calls = [];
    const pages = [
      [kline(4), kline(5), kline(6)],
      [kline(2), kline(3), kline(4)],
      [kline(1), kline(2)],
    ];

    const candles = await fetchHistoricalCandles({
      symbol: 'BTCUSDT',
      interval: '1h',
      candlesNeeded: 5,
      pageLimit: 3,
      now: 10,
      getCandlesFn: async (symbol, interval, limit, params) => {
        calls.push({ symbol, interval, limit, params });
        return pages.shift();
      },
    });

    assert.deepEqual(candles.map(c => c.openTime), [2, 3, 4, 5, 6]);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].params.endTime, 3);
  });

  it('retries transient fetch errors before succeeding', async () => {
    let attempts = 0;
    const candles = await fetchHistoricalCandles({
      symbol: 'ETHUSDT',
      candlesNeeded: 1,
      pageLimit: 1,
      getCandlesFn: async () => {
        attempts++;
        if (attempts === 1) throw new Error('Request timeout');
        return [kline(1)];
      },
      maxRetries: 1,
      retryDelayMs: 0,
    });

    assert.equal(attempts, 2);
    assert.equal(candles.length, 1);
  });

  it('throws a visible error for invalid Binance payloads', async () => {
    await assert.rejects(
      fetchHistoricalCandles({
        symbol: 'SOLUSDT',
        candlesNeeded: 10,
        getCandlesFn: async () => ({ code: -1003, msg: 'Too many requests' }),
      }),
      /Invalid candle payload for SOLUSDT/
    );
  });

  it('throws when usable history is insufficient', async () => {
    await assert.rejects(
      fetchHistoricalCandles({
        symbol: 'BNBUSDT',
        candlesNeeded: 3,
        getCandlesFn: async () => [kline(1)],
      }),
      /Insufficient historical data for BNBUSDT/
    );
  });
});

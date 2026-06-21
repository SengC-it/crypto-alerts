import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backtestSymbol } from '../src/backtest/engine.js';

function candle(index, close = 100) {
  return {
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
    closeTime: index * 3600000,
  };
}

function neutralIndicators(price) {
  return {
    rsi_14: 50,
    rsi_7: 50,
    rsi_21: 50,
    macd: { macd: 0, signal: 0, histogram: 0 },
    bollinger: { upper: price + 10, middle: price, lower: price - 10, bandwidth: 0.2, percentB: 0.5 },
    atr_14: 2,
    donchian: { upper: price + 10, middle: price, lower: price - 10 },
    ema_9: price,
    ema_21: price,
    ema_50: price,
    sma_20: price,
    sma_50: price,
    volume_ma_20: 1000,
    currentPrice: price,
    currentVolume: 1000,
  };
}

describe('Backtest precomputed indicators', () => {
  it('uses provided indicator series instead of recomputing indicators', async () => {
    const candles = Array.from({ length: 220 }, (_, i) => candle(i, 100 + Math.sin(i / 10)));
    const indicatorSeries = candles.map(c => neutralIndicators(c.close));
    let computeCalls = 0;

    const result = await backtestSymbol('BTCUSDT', 1, {
      candles,
      indicatorSeries,
      computeIndicatorsFn: () => {
        computeCalls++;
        throw new Error('should not compute indicators during optimized scan');
      },
    });

    assert.equal(computeCalls, 0);
    assert.equal(result.symbol, 'BTCUSDT');
  });
});

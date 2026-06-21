import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { precomputeIndicatorSeries } from '../src/backtest/indicatorSeries.js';

function candle(index) {
  return {
    open: 100 + index,
    high: 101 + index,
    low: 99 + index,
    close: 100 + index,
    volume: 1000 + index,
    closeTime: index * 3600000,
  };
}

describe('Indicator series precomputation', () => {
  it('computes indicators once per candle index after warmup', () => {
    const calls = [];
    const candles = Array.from({ length: 6 }, (_, i) => candle(i));

    const series = precomputeIndicatorSeries(candles, {
      warmup: 2,
      computeFn: slice => {
        calls.push(slice.length);
        return { currentPrice: slice.at(-1).close };
      },
    });

    assert.equal(series.length, candles.length);
    assert.deepEqual(calls, [3, 4, 5, 6]);
    assert.equal(series[0], null);
    assert.equal(series[1], null);
    assert.deepEqual(series[5], { currentPrice: 105 });
  });
});

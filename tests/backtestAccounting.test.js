import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { calculateNetTradePnl } from '../src/backtest/engine.js';

describe('Backtest fee and slippage accounting', () => {
  it('keeps gross pnl, round-trip cost, and net pnl separate for long trades', () => {
    const result = calculateNetTradePnl({
      direction: 'BUY',
      entryPrice: 100,
      exitPrice: 103,
      feeRatePercent: 0.04,
      slippagePercent: 0.03,
    });

    assert.equal(result.grossPnlPercent, 3);
    assert.equal(result.roundTripCostPercent, 0.14);
    assert.equal(result.netPnlPercent, 2.86);
  });

  it('calculates net pnl for short trades', () => {
    const result = calculateNetTradePnl({
      direction: 'SELL',
      entryPrice: 100,
      exitPrice: 97,
      feeRatePercent: 0.04,
      slippagePercent: 0.03,
    });

    assert.equal(result.grossPnlPercent, 3);
    assert.equal(result.netPnlPercent, 2.86);
  });
});

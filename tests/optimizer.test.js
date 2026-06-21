import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateParameterGrid, rankOptimizationResults, runOptimizationGrid } from '../src/backtest/optimizer.js';

describe('Optimization parameter grid', () => {
  it('generates explicit scenarios from parameter candidates', () => {
    const scenarios = generateParameterGrid({
      minConfidence: [50, 60],
      trailingATR: [0.6, 0.8],
    });

    assert.deepEqual(scenarios, [
      { id: 'minConfidence=50__trailingATR=0.6', options: { minConfidence: 50, trailingATR: 0.6 } },
      { id: 'minConfidence=50__trailingATR=0.8', options: { minConfidence: 50, trailingATR: 0.8 } },
      { id: 'minConfidence=60__trailingATR=0.6', options: { minConfidence: 60, trailingATR: 0.6 } },
      { id: 'minConfidence=60__trailingATR=0.8', options: { minConfidence: 60, trailingATR: 0.8 } },
    ]);
  });

  it('expands dotted parameter names into nested option objects', () => {
    const scenarios = generateParameterGrid({
      minConfidence: [50],
      'strategyOverrides.rsi_reversal.oversold': [30],
    });

    assert.deepEqual(scenarios, [
      {
        id: 'minConfidence=50__strategyOverrides.rsi_reversal.oversold=30',
        options: {
          minConfidence: 50,
          strategyOverrides: {
            rsi_reversal: {
              oversold: 30,
            },
          },
        },
      },
    ]);
  });

  it('ranks scenarios by net return, profit factor, win rate, and drawdown', () => {
    const ranked = rankOptimizationResults([
      { id: 'noisy', summary: { avgNetPnlPercent: 12, avgProfitFactor: 1.2, avgWinRate: 45, avgMaxDrawdownPercent: 20 } },
      { id: 'balanced', summary: { avgNetPnlPercent: 10, avgProfitFactor: 2.1, avgWinRate: 58, avgMaxDrawdownPercent: 5 } },
    ]);

    assert.equal(ranked[0].id, 'balanced');
    assert.ok(ranked[0].score > ranked[1].score);
  });

  it('omits full backtest payloads by default to keep optimization reports bounded', async () => {
    const ranked = await runOptimizationGrid({
      days: 1,
      candidates: { minConfidence: [50] },
      backtestFn: async () => ({
        totalSymbols: 1,
        totalTrades: 1,
        results: [
          {
            totalTrades: 1,
            totalPnlPercent: 1,
            grossPnlPercent: 1,
            totalCostPercent: 0.1,
            winRate: 50,
            profitFactor: 1.2,
            maxDrawdownPercent: 1,
            trades: Array.from({ length: 1000 }, (_, i) => ({ i })),
          },
        ],
        errors: [],
      }),
    });

    assert.equal('backtest' in ranked[0], false);
    assert.deepEqual(ranked[0].dataQuality, { totalSymbols: 1, errors: 0 });
  });
});

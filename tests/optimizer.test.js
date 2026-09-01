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

  it('rejects trailingATR experiments unless trailing stops are enabled', async () => {
    await assert.rejects(
      () => runOptimizationGrid({
        days: 1,
        candidates: { trailingATR: [0.5, 1] },
        backtestFn: async () => ({ results: [], errors: [] }),
      }),
      /trailingATR requires trailingStop=true/,
    );

    await assert.rejects(
      () => runOptimizationGrid({
        days: 1,
        candidates: { trailingStop: [true, false], trailingATR: [0.5, 1] },
        baseOptions: { trailingStop: true },
        backtestFn: async () => ({ results: [], errors: [] }),
      }),
      /trailingATR requires trailingStop=true/,
    );
  });

  it('detects no-op scenarios from actual backtest output', async () => {
    const analysis = await runOptimizationGrid({
      days: 1,
      candidates: { minConfidence: [40, 60] },
      returnAnalysis: true,
      backtestFn: async () => ({
        totalSymbols: 1,
        totalTrades: 1,
        results: [{
          totalTrades: 1,
          rawSignalCount: 2,
          filteredSignalCount: 1,
          totalPnlPercent: 1,
          winRate: 50,
          profitFactor: 1,
          maxDrawdownPercent: 1,
          signalEvaluations: [],
        }],
        errors: [],
      }),
    });

    assert.equal(analysis.noOp.passed, false);
    assert.equal(analysis.parameterEffect.passed, false);
    assert.equal(analysis.parameterEffect.effects[0].parameter, 'minConfidence');
    assert.equal(analysis.parameterEffect.effects[0].outputChanged, false);
  });

  it('reports a parameter effect when the execution output changes', async () => {
    const analysis = await runOptimizationGrid({
      days: 1,
      candidates: { minConfidence: [40, 60] },
      returnAnalysis: true,
      backtestFn: async (_days, options) => ({
        totalSymbols: 1,
        totalTrades: options.minConfidence,
        results: [{
          totalTrades: options.minConfidence,
          rawSignalCount: 2,
          filteredSignalCount: options.minConfidence,
          totalPnlPercent: options.minConfidence,
          winRate: 50,
          profitFactor: 1,
          maxDrawdownPercent: 1,
          signalEvaluations: [{ signal_timestamp: String(options.minConfidence) }],
        }],
        errors: [],
      }),
    });

    assert.equal(analysis.noOp.passed, true);
    assert.equal(analysis.parameterEffect.passed, true);
    assert.equal(analysis.parameterEffect.effects[0].outputChanged, true);
  });

  it('detects fee effects in signal-level net forward returns', async () => {
    const analysis = await runOptimizationGrid({
      days: 1,
      candidates: { roundTripCostPercent: [0.1, 0.2] },
      returnAnalysis: true,
      backtestFn: async (_days, options) => ({
        totalSymbols: 1,
        totalTrades: 0,
        results: [{
          symbol: 'BTCUSDT',
          totalTrades: 0,
          signalEvaluations: [{
            signal_timestamp: '2026-01-01T00:00:00.000Z',
            forward_returns: { '1h': 1 },
            net_forward_returns: { '1h': 1 - options.roundTripCostPercent },
            fee_slippage_cost_percent: options.roundTripCostPercent,
          }],
        }],
        errors: [],
      }),
    });

    assert.equal(analysis.parameterEffect.passed, true);
    assert.equal(analysis.noOp.passed, true);
  });
});

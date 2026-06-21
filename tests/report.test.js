import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { assertUsableBacktestResults, buildOptimizationMarkdown } from '../src/backtest/report.js';

describe('Backtest reports', () => {
  it('treats zero usable symbols as an infrastructure failure', () => {
    assert.throws(
      () => assertUsableBacktestResults({ totalSymbols: 0, errors: [{ symbol: 'BTCUSDT', error: 'timeout' }] }),
      /No usable backtest results/
    );
  });

  it('renders ranked optimization results as Markdown', () => {
    const markdown = buildOptimizationMarkdown({
      title: 'Optimization Report',
      generatedAt: '2026-06-21T00:00:00.000Z',
      days: 30,
      ranked: [
        { id: 'minConfidence=60', score: 12.34, summary: { totalTrades: 10, avgNetPnlPercent: 5.67, avgWinRate: 60, avgProfitFactor: 1.8, avgMaxDrawdownPercent: 4.2 } },
      ],
      errors: [],
    });

    assert.match(markdown, /# Optimization Report/);
    assert.match(markdown, /minConfidence=60/);
    assert.match(markdown, /5\.67%/);
  });
});

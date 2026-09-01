// Parameter scan runner.
// Usage: node scripts/optimize-strategies.js [days]

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { loadBacktestHistory } from '../src/backtest/history.js';
import { precomputeIndicatorSeries } from '../src/backtest/indicatorSeries.js';
import { runOptimizationGrid } from '../src/backtest/optimizer.js';
import { buildOptimizationMarkdown } from '../src/backtest/report.js';

const days = parseInt(process.argv[2], 10) || 30;
const generatedAt = new Date().toISOString();
const asOf = Date.parse(generatedAt);
const indicatorLookbackCandles = getIndicatorLookback(CONFIG);
const stamp = generatedAt.replace(/[:.]/g, '-');
const outDir = path.join(process.cwd(), 'reports', 'backtests');

const candidates = {
  minConfidence: [40, 50, 60, 75],
  trailingATR: [0.5, 0.6, 0.8, 1.0],
  'strategyOverrides.rsi_reversal.oversold': [30, 35, 40],
  'strategyOverrides.rsi_reversal.overbought': [60, 65, 70],
};

fs.mkdirSync(outDir, { recursive: true });

async function main() {
  console.log(`Running optimization grid for ${days} days...`);
  console.log(`Scenarios: ${Object.values(candidates).reduce((total, values) => total * values.length, 1)}`);

  const candlesBySymbol = {};
  const indicatorsBySymbol = {};
  const coverageBySymbol = {};
  const dataErrors = [];

  console.log(`Loading strict ${days}-day coverage for ${CONFIG.BINANCE_SYMBOLS.length} symbols...`);
  for (const symbol of CONFIG.BINANCE_SYMBOLS) {
    try {
      const history = await loadBacktestHistory(symbol, days, {
        timeframe: '1h',
        asOf,
        indicatorLookbackCandles,
        strictCoverage: true,
      });
      candlesBySymbol[symbol] = history.candles;
      coverageBySymbol[symbol] = history.coverage;
      indicatorsBySymbol[symbol] = precomputeIndicatorSeries(candlesBySymbol[symbol], {
        symbol,
        timeframe: '1h',
        config: CONFIG,
        indicatorLookbackCandles,
      });
      console.log(`  ${symbol}: ${history.coverage.coverage_percent}% coverage, ${candlesBySymbol[symbol].length} candles`);
    } catch (err) {
      dataErrors.push({ symbol, error: err.message });
      console.log(`  ${symbol}: ERROR ${err.message}`);
    }
  }

  if (dataErrors.length > 0 || Object.keys(candlesBySymbol).length !== CONFIG.BINANCE_SYMBOLS.length) {
    throw new Error(`Optimization requires complete data for every symbol. Errors: ${JSON.stringify(dataErrors)}`);
  }

  const analysis = await runOptimizationGrid({
    days,
    candidates,
    baseOptions: {
      candlesBySymbol,
      indicatorsBySymbol,
      asOf,
      indicatorLookbackCandles,
      strictCoverage: true,
      trailingStop: true,
    },
    returnAnalysis: true,
    failOnNoOp: true,
  });
  const ranked = analysis.ranked;
  const payload = {
    title: 'Crypto Alerts Optimization Report',
    generatedAt,
    days,
    ranked,
    coverageBySymbol,
    parameterEffect: analysis.parameterEffect,
    noOp: analysis.noOp,
    errors: dataErrors,
  };

  const jsonPath = path.join(outDir, `optimization-${days}d-${stamp}.json`);
  const mdPath = path.join(outDir, `optimization-${days}d-${stamp}.md`);
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2));
  fs.writeFileSync(mdPath, buildOptimizationMarkdown(payload));

  console.log(`\nTop scenarios:`);
  for (const item of ranked.slice(0, 10)) {
    const s = item.summary;
    console.log(`${item.id} | score=${item.score} | trades=${s.totalTrades} | net=${s.avgNetPnlPercent}% | pf=${s.avgProfitFactor} | dd=${s.avgMaxDrawdownPercent}%`);
  }

  console.log(`\nWrote:\n  ${jsonPath}\n  ${mdPath}`);
}

main().catch(err => {
  console.error(`Optimization failed: ${err.stack || err.message}`);
  process.exit(1);
});

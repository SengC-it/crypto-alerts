// Fee-adjusted backtest comparison.
// Usage: node scripts/fee-adjusted-backtest.js [days]

import { backtestAll } from '../src/backtest/engine.js';
import { assertUsableBacktestResults } from '../src/backtest/report.js';

const days = parseInt(process.argv[2], 10) || 30;
const scenarios = [
  { label: 'high-frequency', minConfidence: 40 },
  { label: 'balanced', minConfidence: 60 },
  { label: 'selective', minConfidence: 75 },
];

console.log(`\n${'='.repeat(72)}`);
console.log(`  Fee-adjusted backtest comparison (${days} days)`);
console.log('  Costs are applied inside the backtest engine per closed trade.');
console.log(`${'='.repeat(72)}\n`);

async function runScenario({ label, minConfidence }) {
  console.log(`\n${'-'.repeat(56)}`);
  console.log(`  Scenario: ${label} (minConfidence=${minConfidence})`);
  console.log(`${'-'.repeat(56)}`);

  const result = assertUsableBacktestResults(await backtestAll(days, { minConfidence }));
  const usable = result.results.filter(r => !r.error && r.totalTrades > 0);
  const totals = usable.reduce((acc, r) => {
    acc.trades += r.totalTrades || 0;
    acc.wins += r.wins || 0;
    acc.net += r.totalPnlPercent || 0;
    acc.gross += r.grossPnlPercent || 0;
    acc.cost += r.totalCostPercent || 0;
    acc.profitable += (r.totalPnlPercent || 0) > 0 ? 1 : 0;
    return acc;
  }, { trades: 0, wins: 0, net: 0, gross: 0, cost: 0, profitable: 0 });

  const count = usable.length;
  const avg = value => count > 0 ? +(value / count).toFixed(2) : 0;
  const winRate = totals.trades > 0 ? +((totals.wins / totals.trades) * 100).toFixed(1) : 0;

  console.log(`  Usable symbols: ${count}/${result.totalSymbols}`);
  console.log(`  Trades: ${totals.trades}`);
  console.log(`  Win rate: ${winRate}%`);
  console.log(`  Avg simple gross trade PnL/symbol: ${avg(totals.gross)}%`);
  console.log(`  Avg simple round-trip cost/symbol: ${avg(totals.cost)}%`);
  console.log(`  Avg compounded net return/symbol: ${avg(totals.net)}%`);
  console.log(`  Profitable symbols: ${totals.profitable}/${count}`);

  if (result.errors?.length) {
    console.log(`  Data errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`    - ${err.symbol || 'unknown'}: ${err.error || JSON.stringify(err)}`);
    }
  }

  return { label, minConfidence, ...totals, symbols: count, winRate, avgNet: avg(totals.net) };
}

const compared = [];
for (const scenario of scenarios) {
  compared.push(await runScenario(scenario));
}

console.log(`\n${'='.repeat(72)}`);
console.log('  Scenario summary');
console.log(`${'='.repeat(72)}\n`);
console.log('Scenario'.padEnd(18) + 'Conf\tTrades\tWinRate\tAvgNetReturn\tProfitable');
console.log('-'.repeat(64));
for (const row of compared) {
  console.log(`${row.label.padEnd(18)}${row.minConfidence}\t${row.trades}\t${row.winRate}%\t${row.avgNet}%\t${row.profitable}/${row.symbols}`);
}

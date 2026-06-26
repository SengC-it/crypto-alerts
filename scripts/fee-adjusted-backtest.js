// Fee-adjusted backtest comparison.
// Usage: node scripts/fee-adjusted-backtest.js [days]

import { CONFIG } from '../src/config.js';
import { backtestAll } from '../src/backtest/engine.js';

const days = parseInt(process.argv[2]) || 30;
const roundTripCostPercent = CONFIG.TRADING_COSTS.roundTripPercent;

console.log(`\n${'='.repeat(70)}`);
console.log('  Fee-adjusted backtest comparison');
console.log(`  Round-trip cost: ${roundTripCostPercent.toFixed(2)}% per trade`);
console.log(`${'='.repeat(70)}\n`);

function summarizeTrades(trades) {
  return trades.reduce(
    (acc, trade) => {
      acc.gross += trade.grossPnl ?? trade.pnl;
      acc.cost += trade.cost ?? 0;
      acc.net += trade.pnl;
      return acc;
    },
    { gross: 0, cost: 0, net: 0 }
  );
}

async function runScenario(label, minConfidence) {
  console.log(`\n${'-'.repeat(50)}`);
  console.log(`  Scenario: ${label} (minConfidence=${minConfidence}%)`);
  console.log(`${'-'.repeat(50)}`);

  const result = await backtestAll(days, { minConfidence });

  let totalGrossPnl = 0;
  let totalCost = 0;
  let totalNetPnl = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let profitableCoins = 0;

  const coinPnls = result.results
    .filter(r => !r.error && r.trades)
    .map(r => {
      const totals = summarizeTrades(r.trades);
      totalGrossPnl += totals.gross;
      totalCost += totals.cost;
      totalNetPnl += totals.net;
      totalTrades += r.trades.length;
      totalWins += r.wins || 0;
      if (totals.net > 0) profitableCoins++;

      return {
        symbol: r.symbol,
        tier: r.tier,
        trades: r.trades.length,
        gross: +totals.gross.toFixed(2),
        cost: +totals.cost.toFixed(2),
        net: +totals.net.toFixed(2),
        winRate: r.winRate,
      };
    })
    .sort((a, b) => b.net - a.net);

  const coinCount = coinPnls.length;
  const totalWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0';
  const avgNetPnl = coinCount > 0 ? (totalNetPnl / coinCount).toFixed(2) : '0';
  const expectancy = totalTrades > 0 ? (totalNetPnl / totalTrades).toFixed(2) : '0';

  console.log('\n  Summary:');
  console.log(`    Symbols:          ${coinCount}`);
  console.log(`    Trades:           ${totalTrades}`);
  console.log(`    Win rate:         ${totalWinRate}%`);
  console.log(`    Gross PnL:        ${totalGrossPnl.toFixed(2)}%`);
  console.log(`    Cost:             ${totalCost.toFixed(2)}%`);
  console.log(`    Net PnL:          ${totalNetPnl.toFixed(2)}%`);
  console.log(`    Avg net / symbol: ${avgNetPnl}%`);
  console.log(`    Expectancy:       ${expectancy}% per trade`);
  console.log(`    Profitable coins: ${profitableCoins}/${coinCount}`);

  console.log('\n  Coin ranking:');
  console.log('  Symbol'.padEnd(14) + 'Tier\tTrades\tGross\tCost\tNet\tWinRate');
  console.log('  ' + '-'.repeat(70));
  for (const coin of coinPnls) {
    const mark = coin.net > 0 ? '+' : '';
    console.log(
      `  ${coin.symbol.padEnd(14)}${coin.tier}\t${coin.trades}\t${coin.gross}%\t${coin.cost}%\t${mark}${coin.net}%\t${coin.winRate}%`
    );
  }

  return { avgNetPnl: +avgNetPnl, profitableCoins, coinCount, totalTrades };
}

const scenarios = [
  { label: 'High frequency', minConfidence: 40 },
  { label: 'Balanced', minConfidence: 60 },
  { label: 'Selective', minConfidence: 75 },
];

const compared = [];
for (const scenario of scenarios) {
  const result = await runScenario(scenario.label, scenario.minConfidence);
  compared.push({ ...scenario, ...result });
}

console.log(`\n${'='.repeat(70)}`);
console.log('  Scenario comparison');
console.log(`${'='.repeat(70)}\n`);
console.log('Scenario'.padEnd(16) + 'MinConf\tTrades\tAvgNet/Symbol\tProfitable');
console.log('-'.repeat(62));
for (const row of compared) {
  console.log(
    `${row.label.padEnd(16)}${row.minConfidence}%\t${row.totalTrades}\t${row.avgNetPnl}%\t\t${row.profitableCoins}/${row.coinCount}`
  );
}

console.log('\n====== Analysis complete ======\n');

// 费后回测对比脚本
// 对比不同置信度阈值下的净收益（扣除手续费、滑点）
// 使用方法: node scripts/fee-adjusted-backtest.js [days]

import { backtestAll } from '../src/backtest/engine.js';

const days = parseInt(process.argv[2]) || 30;
const FEE_RATE = 0.04;     // Binance Futures taker fee: 0.04% per side
const SLIPPAGE = 0.03;     // 滑点估算: 0.03% per side
const ROUND_TRIP_COST = (FEE_RATE * 2 + SLIPPAGE * 2) / 100; // ~0.14%

console.log(`\n${'='.repeat(70)}`);
console.log(`  费后回测对比 (手续费${FEE_RATE * 2}% + 滑点${SLIPPAGE * 2}%)`);
console.log(`  往返成本: ${(ROUND_TRIP_COST * 100).toFixed(2)}%/笔`);
console.log(`${'='.repeat(70)}\n`);

async function runScenario(label, minConf) {
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`  场景: ${label} (最低置信度=${minConf}%)`);
  console.log(`${'─'.repeat(50)}`);

  const result = await backtestAll(days, { minConfidence: minConf });

  let totalGrossPnl = 0;
  let totalFeeCost = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let profitableCoins = 0;

  for (const r of result.results) {
    if (r.error || !r.trades) continue;
    const trades = r.trades;
    const tradesCount = trades.length;
    const feeCost = tradesCount * ROUND_TRIP_COST * 100; // 以%计
    const grossPnl = r.totalPnlPercent || 0;
    const netPnl = grossPnl - feeCost;

    totalGrossPnl += grossPnl;
    totalFeeCost += feeCost;
    totalTrades += tradesCount;
    totalWins += r.wins || 0;
    if (netPnl > 0) profitableCoins++;
  }

  const coinCount = result.results.filter(r => !r.error && r.trades).length;
  const avgGrossPnl = coinCount > 0 ? (totalGrossPnl / coinCount).toFixed(2) : '0';
  const avgFeeCost = coinCount > 0 ? (totalFeeCost / coinCount).toFixed(2) : '0';
  const avgNetPnl = coinCount > 0 ? ((totalGrossPnl - totalFeeCost) / coinCount).toFixed(2) : '0';
  const totalWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) : '0';
  const avgTradesPerCoin = coinCount > 0 ? (totalTrades / coinCount).toFixed(0) : '0';

  // 按档位分
  const tierStats = {};
  for (const r of result.results) {
    if (r.error || !r.trades) continue;
    const tier = r.tier || 'unknown';
    if (!tierStats[tier]) tierStats[tier] = { coins: 0, gross: 0, fees: 0, trades: 0, wins: 0, netProfitable: 0 };
    tierStats[tier].coins++;
    tierStats[tier].gross += r.totalPnlPercent || 0;
    tierStats[tier].fees += (r.trades.length) * ROUND_TRIP_COST * 100;
    tierStats[tier].trades += r.trades.length;
    tierStats[tier].wins += r.wins || 0;
    const net = (r.totalPnlPercent || 0) - (r.trades.length) * ROUND_TRIP_COST * 100;
    if (net > 0) tierStats[tier].netProfitable++;
  }

  console.log(`\n  总览:`);
  console.log(`    币种数:     ${coinCount}`);
  console.log(`    总交易:     ${totalTrades}笔 (平均${avgTradesPerCoin}笔/币)`);
  console.log(`    胜率:       ${totalWinRate}%`);
  console.log(`    平均毛盈亏: ${avgGrossPnl}%/币`);
  console.log(`    平均手续费: ${avgFeeCost}%/币`);
  console.log(`    平均净盈亏: ${avgNetPnl}%/币`);
  console.log(`    费后盈利币: ${profitableCoins}/${coinCount}`);

  console.log(`\n  按档位:`);
  for (const [tier, stats] of Object.entries(tierStats)) {
    const avgNet = stats.coins > 0 ? ((stats.gross - stats.fees) / stats.coins).toFixed(2) : '0';
    const wr = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0';
    console.log(`    ${tier}: ${stats.coins}币 | ${stats.trades}笔 | 胜率${wr}% | 净盈亏${avgNet}%/币 | 费后盈利${stats.netProfitable}/${stats.coins}`);
  }

  // 打印各币种费后排名
  const coinPnls = result.results
    .filter(r => !r.error && r.trades)
    .map(r => ({
      symbol: r.symbol,
      tier: r.tier,
      trades: r.trades.length,
      gross: r.totalPnlPercent || 0,
      fees: (r.trades.length * ROUND_TRIP_COST * 100).toFixed(2),
      net: +((r.totalPnlPercent || 0) - r.trades.length * ROUND_TRIP_COST * 100).toFixed(2),
      winRate: r.winRate,
    }))
    .sort((a, b) => b.net - a.net);

  console.log(`\n  各币种费后排名:`);
  console.log('  币种'.padEnd(14) + '档位\t笔数\t毛盈亏\t手续费\t净盈亏\t胜率');
  console.log('  ' + '-'.repeat(65));
  for (const c of coinPnls) {
    const mark = c.net > 0 ? '+' : '';
    console.log(`  ${c.symbol.padEnd(14)}${c.tier}\t${c.trades}\t${c.gross.toFixed(1)}%\t${c.fees}%\t${mark}${c.net}%\t${c.winRate}%`);
  }

  return { avgNetPnl: +avgNetPnl, profitableCoins, coinCount, totalTrades };
}

// 对比三个场景
const scenarios = [
  { label: '高频（当前）', minConf: 40 },
  { label: '中频（稳健）', minConf: 60 },
  { label: '低频（精选）', minConf: 75 },
];

const compared = [];
for (const s of scenarios) {
  const result = await runScenario(s.label, s.minConf);
  compared.push({ ...s, ...result });
}

console.log(`\n${'='.repeat(70)}`);
console.log(`  场景对比汇总`);
console.log(`${'='.repeat(70)}\n`);
console.log('场景'.padEnd(16) + '置信度\t交易数\t净盈亏/币\t费后盈利币');
console.log('-'.repeat(55));
for (const c of compared) {
  console.log(`${c.label.padEnd(16)}${c.minConf}%\t${c.totalTrades}\t${c.avgNetPnl}%\t${c.profitableCoins}/${c.coinCount}`);
}

console.log('\n====== 分析完成 ======\n');

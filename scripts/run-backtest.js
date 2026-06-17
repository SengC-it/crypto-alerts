// 全币种回测运行脚本
// 使用方法: node scripts/run-backtest.js [days] [minConfidence]

import { backtestAll, backtestSymbol } from '../src/backtest/engine.js';

const days = parseInt(process.argv[2]) || 30;
const minConfidence = parseFloat(process.argv[3]) || 0;

console.log(`\n========================================`);
console.log(`  Crypto Alerts 回测`);
console.log(`  时间范围: ${days} 天 | 最低置信度: ${minConfidence}`);
console.log(`========================================\n`);

try {
  const result = await backtestAll(days, {
    minConfidence,
    noConflictFilter: true,
    usePosition: true,
    positionTimeout: 48,
    leverage: 1,
    initialCapital: 10000,
  });

  console.log('\n====== 汇总统计 ======\n');
  console.log(`总交易次数: ${result.totalTrades}`);
  console.log(`平均胜率: ${result.avgWinRate}`);

  console.log('\n====== 各策略全局表现 ======\n');
  const stratEntries = Object.entries(result.globalStrategyStats);
  if (stratEntries.length > 0) {
    console.log('策略名\t\t\t胜\t负\t总盈亏%');
    console.log('-'.repeat(50));
    for (const [name, s] of stratEntries) {
      const total = s.wins + s.losses;
      const wr = total > 0 ? ((s.wins / total) * 100).toFixed(1) + '%' : 'N/A';
      console.log(`${name.padEnd(28)}${s.wins}\t${s.losses}\t${s.totalPnl.toFixed(2)}%\t胜率:${wr}`);
    }
  }

  console.log('\n====== 各币种详情 ======\n');
  for (const r of result.results) {
    if (r.error) {
      console.log(`${r.symbol}: 错误 - ${r.error}`);
      continue;
    }
    console.log(`\n--- ${r.symbol} ---`);
    console.log(`  交易: ${r.totalTrades} | 胜率: ${r.winRate} | 盈亏: ${r.totalPnlPercent} | 最大回撤: ${r.maxDrawdownPercent}`);
    console.log(`  盈利因子: ${r.profitFactor} | 平均盈利: ${r.avgWinPnl} | 平均亏损: ${r.avgLossPnl}`);
    console.log(`  平仓原因: ${JSON.stringify(r.exitReasons)}`);

    if (Object.keys(r.byStrategy || {}).length > 0) {
      console.log('  策略表现:');
      for (const [sn, sv] of Object.entries(r.byStrategy)) {
        const t = sv.wins + sv.losses;
        const wr = t > 0 ? ((sv.wins / t) * 100).toFixed(1) + '%' : 'N/A';
        console.log(`    ${sn}: ${sv.wins}W/${sv.losses}L (${wr}) 盈亏: ${sv.totalPnl.toFixed(2)}%`);
      }
    }
  }

  if (result.errors.length > 0) {
    console.log('\n====== 错误 ======\n');
    for (const e of result.errors) {
      console.log(`${e.symbol || 'Unknown'}: ${e.error || JSON.stringify(e)}`);
    }
  }

  console.log('\n====== 回测完成 ======\n');
} catch (err) {
  console.error('回测执行失败:', err);
  process.exit(1);
}

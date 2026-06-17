// 全币种回测运行脚本 v2
// 使用方法: node scripts/run-backtest.js [days] [options]
//   days: 回测天数, 默认 30
//   --tier=1/2/3: 只测指定档位
//   --trailing: 启用移动止损

import { backtestAll, backtestSymbol } from '../src/backtest/engine.js';

const args = process.argv.slice(2);
const days = parseInt(args[0]) || 30;
const tierArg = args.find(a => a.startsWith('--tier='));
const trailingArg = args.includes('--trailing');
const tier = tierArg ? `tier${tierArg.split('=')[1]}` : null;

console.log(`\n${'='.repeat(60)}`);
console.log(`  Crypto Alerts 回测 v2`);
console.log(`  时间: ${days}天 | 档位: ${tier || '全部'} | 移动止损: ${trailingArg ? 'ON' : 'OFF'}`);
console.log(`${'='.repeat(60)}\n`);

try {
  const result = await backtestAll(days, {
    tier,
    trailingStop: trailingArg,
  });

  // ===== 档位汇总 =====
  console.log('\n====== 档位汇总 ======\n');
  for (const [tierKey, stats] of Object.entries(result.byTier || {})) {
    const wr = stats.totalTrades > 0 ? ((stats.totalWins / stats.totalTrades) * 100).toFixed(1) : 'N/A';
    const avgDD = stats.symbols > 0 ? (stats.totalDD / stats.symbols).toFixed(1) : 'N/A';
    const avgPnl = stats.symbols > 0 ? (stats.totalPnl / stats.symbols).toFixed(1) : 'N/A';
    console.log(`${tierKey}: ${stats.symbols}币 | ${stats.totalTrades}笔 | 胜率${wr}% | 平均盈亏${avgPnl}% | 平均回撤${avgDD}%`);
  }

  // ===== 全局策略 =====
  console.log('\n====== 各策略全局表现 ======\n');
  const stratEntries = Object.entries(result.globalStrategyStats);
  if (stratEntries.length > 0) {
    console.log('策略'.padEnd(28) + '笔数\t胜\t负\t胜率\t盈亏%\t评分');
    console.log('-'.repeat(70));
    for (const [name, s] of stratEntries) {
      const total = s.wins + s.losses;
      const wr = total > 0 ? ((s.wins / total) * 100).toFixed(1) + '%' : 'N/A';
      // 评分 = 盈亏 * 胜率 / 100（越高越好）
      const score = total > 0 ? (s.totalPnl * (s.wins / total) / Math.max(total, 1)).toFixed(2) : '0';
      console.log(`${name.padEnd(28)}${total}\t${s.wins}\t${s.losses}\t${wr}\t${s.totalPnl.toFixed(1)}%\t${score}`);
    }
  }

  // ===== 方向统计 =====
  console.log('\n====== 做多/做空对比 ======\n');
  for (const [dir, stats] of Object.entries(result.globalDirection || {})) {
    const wr = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(1) : 'N/A';
    console.log(`${dir}: ${stats.count}笔 | 胜率${wr}% | 总盈亏${stats.pnl.toFixed(1)}%`);
  }

  // ===== 平仓原因 =====
  console.log('\n====== 平仓原因分布 ======\n');
  for (const [reason, count] of Object.entries(result.globalExitReasons || {})) {
    const pct = ((count / result.totalTrades) * 100).toFixed(1);
    console.log(`${reason}: ${count} (${pct}%)`);
  }

  // ===== 各币种详情 =====
  console.log('\n====== 各币种详情 ======\n');
  // 按盈亏排序
  const sorted = [...result.results].sort((a, b) => (b.totalPnlPercent || 0) - (a.totalPnlPercent || 0));
  console.log('币种'.padEnd(14) + '档位\t笔数\t胜率\t盈亏%\t回撤%\t盈利因子\t夏普\t大赢/大亏');
  console.log('-'.repeat(90));
  for (const r of sorted) {
    if (r.error) { console.log(`${r.symbol}: 错误 - ${r.error}`); continue; }
    const bw = r.bigWins || 0;
    const bl = r.bigLosses || 0;
    console.log(
      `${r.symbol.padEnd(14)}${r.tier}\t${r.totalTrades}\t${r.winRate}%\t${r.totalPnlPercent}%\t${r.maxDrawdownPercent}%\t${r.profitFactor}\t${r.sharpeRatio}\t${bw}/${bl}`
    );
  }

  // ===== 亏损分析 =====
  console.log('\n====== 亏损币种深度分析 ======\n');
  const losers = sorted.filter(r => r.totalPnlPercent < 0);
  for (const r of losers) {
    console.log(`\n--- ${r.symbol} (Tier ${r.tier}) 盈亏: ${r.totalPnlPercent}% ---`);
    // 找亏损最多的策略
    const stratEntries = Object.entries(r.byStrategy || {});
    for (const [sn, sv] of stratEntries) {
      if (sv.totalPnl < 0) {
        console.log(`  亏损策略: ${sn} → ${sv.wins}W/${sv.losses}L 盈亏${sv.totalPnl.toFixed(2)}%`);
      }
    }
    // 方向分析
    for (const [dir, stats] of Object.entries(r.byDirection || {})) {
      const wr = stats.count > 0 ? ((stats.wins / stats.count) * 100).toFixed(1) : 'N/A';
      console.log(`  ${dir}: ${stats.count}笔 胜率${wr}% 盈亏${stats.pnl.toFixed(2)}%`);
    }
    // 大亏损交易
    const bigLossTrades = (r.trades || []).filter(t => t.pnl < -2).slice(-5);
    if (bigLossTrades.length > 0) {
      console.log('  最近大亏交易:');
      for (const t of bigLossTrades) {
        console.log(`    ${t.direction} ${t.strategy} @${t.entry}→${t.exit} (${t.exitReason}) pnl=${t.pnl}% conf=${t.confidence}`);
      }
    }
  }

  if (result.errors.length > 0) {
    console.log('\n====== 错误 ======\n');
    for (const e of result.errors) {
      console.log(`${e.symbol || 'Unknown'}: ${e.error || JSON.stringify(e)}`);
    }
  }

  // ===== 汇总 =====
  console.log('\n====== 回测汇总 ======\n');
  console.log(`回测币种: ${result.totalSymbols}`);
  console.log(`总交易次数: ${result.totalTrades}`);
  console.log(`平均胜率: ${result.avgWinRate}%`);
  const totalPnl = result.results.reduce((s, r) => s + (r.totalPnlPercent || 0), 0);
  const avgPnl = result.totalSymbols > 0 ? (totalPnl / result.totalSymbols).toFixed(2) : '0';
  console.log(`平均盈亏: ${avgPnl}%/币种`);
  const profitable = result.results.filter(r => (r.totalPnlPercent || 0) > 0).length;
  console.log(`盈利币种: ${profitable}/${result.totalSymbols}`);

  console.log('\n====== 回测完成 ======\n');
} catch (err) {
  console.error('回测执行失败:', err);
  process.exit(1);
}

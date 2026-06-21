export function assertUsableBacktestResults(result) {
  if (!result || (result.totalSymbols || 0) === 0) {
    const errors = (result?.errors || []).map(e => `${e.symbol || 'unknown'}: ${e.error || JSON.stringify(e)}`).join('; ');
    throw new Error(`No usable backtest results. Data pipeline failed or all symbols errored. ${errors}`);
  }
  return result;
}

export function buildOptimizationMarkdown({ title, generatedAt, days, ranked, errors = [] }) {
  const lines = [
    `# ${title}`,
    '',
    `Generated: ${generatedAt}`,
    `Window: ${days} days`,
    '',
    '| Rank | Scenario | Score | Trades | Net PnL/Symbol | Win Rate | Profit Factor | Max DD |',
    '|---:|---|---:|---:|---:|---:|---:|---:|',
  ];

  ranked.forEach((item, index) => {
    const s = item.summary || {};
    lines.push(`| ${index + 1} | ${item.id} | ${item.score} | ${s.totalTrades || 0} | ${s.avgNetPnlPercent || 0}% | ${s.avgWinRate || 0}% | ${s.avgProfitFactor || 0} | ${s.avgMaxDrawdownPercent || 0}% |`);
  });

  if (errors.length > 0) {
    lines.push('', '## Data Errors', '');
    for (const err of errors) {
      lines.push(`- ${err.symbol || 'unknown'}: ${err.error || JSON.stringify(err)}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

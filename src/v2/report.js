// Compact, audit-friendly M1 report renderer. Scores are explicitly ranking
// scores and never win-probability claims.

function display(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  if (typeof value === 'number') return `${value}${suffix}`;
  return String(value);
}

function breadthTable(title, values) {
  const lines = [`### ${title}`, '', '| Bucket | Samples | Expectancy | PF | Hit rate |', '|---|---:|---:|---:|---:|'];
  for (const [key, value] of Object.entries(values || {})) {
    lines.push(`| ${key} | ${value.sample_count || 0} | ${display(value.net_expectancy_percent, '%')} | ${display(value.net_profit_factor)} | ${display(value.hit_rate_percent, '%')} |`);
  }
  return lines;
}

export function buildM1Markdown(result) {
  const metrics = result.metrics?.v2 || {};
  const v1 = result.metrics?.v1 || {};
  const gate = result.promotion || {};
  const walk = result.walk_forward || {};
  const benchmark = result.benchmark || {};
  const lines = [
    '# M1 V2 Signal Quality Engine',
    '',
    `Experiment: \`${result.experiment_id || 'unknown'}\``,
    `Model version: \`${result.model_version || 'unknown'}\``,
    `Mode: \`${result.mode || 'SHADOW_ONLY'}\``,
    '',
    '## Safety boundary',
    '',
    '- V1 production path is unchanged and remains the comparator baseline.',
    '- V2 candidates are retained for research and every candidate is `SHADOW`.',
    '- No exchange private API, order, position, leverage, or account-sizing code is used.',
    '- `edge_score` is a ranking score, not a probability.',
    '',
    '## Canonical benchmark',
    '',
    `- Trigger: ${benchmark.candles?.timeframe || '1h'} closed candle; context: 4h closed candle.`,
    `- Symbols: ${(benchmark.symbols || []).join(', ') || 'N/A'}`,
    `- Horizons: ${(benchmark.evaluation_horizons || []).map(value => `${value}h`).join(', ') || 'N/A'}`,
    `- Round-trip cost: ${display(benchmark.fees?.round_trip_percent, '%')}; slippage included conservatively.`,
    `- Data source: ${benchmark.data_source || 'unknown'}`,
    `- Account-return claim: ${benchmark.account_return_claim === false ? 'none' : 'not declared'}`,
    '',
    '## Historical coverage',
    '',
    '| Symbol | Loaded | Expected | Missing | Coverage |',
    '|---|---:|---:|---:|---:|',
  ];
  for (const item of result.historical_coverage?.per_symbol || []) {
    lines.push(`| ${item.symbol} | ${item.candles_loaded} | ${item.candles_expected} | ${item.missing_candles} | ${item.coverage_percent}% |`);
  }
  lines.push(
    '',
    `Coverage complete: **${result.historical_coverage?.complete ? 'true' : 'false'}**`,
    '',
    '## Purged walk-forward',
    '',
    `- Status: **${walk.status || 'INSUFFICIENT_EVIDENCE'}**`,
    `- OOS windows: ${walk.window_count || 0}; positive windows: ${walk.positive_windows || 0}`,
    `- Purge hours: ${walk.options?.purgeHours ?? 'N/A'}; embargo hours: ${walk.options?.embargoHours ?? 'N/A'}`,
    `- Final holdout: ${walk.final_holdout_count || 0} samples; untouched: ${walk.final_holdout_untouched === true}`,
    `- Holdout boundary: ${display(walk.final_holdout_boundary?.development_max_timestamp)} < ${display(walk.final_holdout_boundary?.final_holdout_min_timestamp)}; event intersection: ${walk.final_holdout_boundary?.assertions?.event_intersection_count ?? 'N/A'}`,
    `- Holdout purge/embargo: ${walk.final_holdout_boundary?.purged_development_count ?? 'N/A'} purged; ${walk.final_holdout_boundary?.embargoed_development_count ?? 'N/A'} embargoed; hash: ${walk.final_holdout_hash || 'N/A'}`,
    '',
    '## OOS selection lanes',
    '',
    `- All candidates: ${result.selection?.oos?.all_candidates ?? result.selection?.all_candidates ?? 0}`,
    `- Score-eligible candidates: ${result.selection?.oos?.score_eligible_candidates ?? 0}`,
    `- Cluster-selected candidates: ${result.selection?.oos?.cluster_selected_candidates ?? 0}`,
    `- Independent market events: ${result.selection?.oos?.independent_market_events ?? 0}`,
    '- Only cluster-selected candidates enter primary V2 promotion metrics; other OOS rows remain in the audit lane.',
    '',
    '## V2 OOS metrics',
    '',
    `- Independent market clusters: ${metrics.independent_market_clusters || 0}`,
    `- Net PF: ${display(metrics.net_profit_factor)}`,
    `- Net expectancy: ${display(metrics.net_expectancy_percent, '%/signal')}`,
    `- Gross expectancy: ${display(metrics.gross_expectancy_percent, '%/signal')}`,
    `- Hit rate: ${display(metrics.hit_rate_percent, '%')}; false-positive rate: ${display(metrics.false_positive_rate_percent, '%')}`,
    `- MFE: ${display(metrics.avg_mfe_percent, '%')}; MAE: ${display(metrics.avg_mae_percent, '%')}; signal decay: ${display(metrics.signal_decay_percent, '%')}`,
    `- Research barriers: TP-first ${metrics.tp_first_count || 0}; SL-first ${metrics.sl_first_count || 0}; neither ${metrics.neither_count || 0}; ambiguous ${metrics.ambiguous_count || 0}; conservative SL-first ${metrics.conservative_sl_first_count || 0}`,
    '',
    ...breadthTable('Direction breadth', metrics.direction_breadth),
    '',
    ...breadthTable('Regime breadth', metrics.regime_breadth),
    '',
    ...breadthTable('Volatility breadth', metrics.volatility_breadth),
    '',
    '## Score calibration',
    '',
    `- Status: **${result.calibration?.status || 'CALIBRATION_FAIL'}**`,
    `- Samples: ${result.calibration?.sample_count || 0}; monotonic OOS expectancy: ${result.calibration?.monotonic_oos_expectancy === true}`,
    '- No calibration result is described as a win probability.',
    '',
    '## V1 comparator',
    '',
    `- V1 samples: ${v1.sample_count || 0}; V2 samples: ${metrics.sample_count || 0}`,
    `- V1 net PF: ${display(v1.net_profit_factor)}; V2 net PF: ${display(metrics.net_profit_factor)}`,
    `- V1 net expectancy: ${display(v1.net_expectancy_percent, '%/signal')}; V2 net expectancy: ${display(metrics.net_expectancy_percent, '%/signal')}`,
    `- V2 minus V1 net expectancy: ${display(result.comparison?.delta?.net_expectancy_percent, '%/signal')}; same contract: ${result.comparison?.same_data_contract === true}`,
    `- Signal/cluster counts: ${JSON.stringify(result.comparison?.counts || {})}`,
    '- Same symbols, candles, horizons, fees, slippage assumptions, event window and date range are required.',
    '',
    '## Training-selected volatility policy',
    '',
    ...(walk.trained_policy_summary || []).map(item => `- Window ${item.window_index}: ${JSON.stringify(item.model_summary?.volatility_policy || {})}`),
    '',
    '## Promotion gate',
    '',
    `Recommendation: **${gate.recommendation || 'INSUFFICIENT_EVIDENCE'}**`,
    '',
    `Observed: \`${JSON.stringify(gate.observed || {})}\``,
    `Failures: ${gate.failures?.join(', ') || 'none'}`,
    '',
    'The M1 implementation does not promote or deploy V2. Final holdout results are kept isolated from tuning.',
    '',
  );
  return `${lines.join('\n')}\n`;
}

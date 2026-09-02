// Compact human-readable report for the bounded M1.1 edge-discovery run.

function display(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  if (typeof value === 'number') return `${value}${suffix}`;
  return String(value);
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function metricTable(title, values) {
  const lines = [
    `### ${title}`,
    '',
    '| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |',
    '|---|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const [key, value] of Object.entries(values || {})) {
    lines.push(`| ${key} | ${value.candidates ?? value.sample_count ?? 0} | ${value.score_eligible ?? '-'} | ${value.cluster_selected ?? value.selected_oos_signals ?? 0} | ${value.independent_clusters ?? value.independent_market_clusters ?? 0} | ${display(value.net_profit_factor)} | ${display(value.net_expectancy_percent, '%')} | ${value.calibration || value.score_calibration?.status || 'N/A'} |`);
  }
  return lines;
}

function formatPolicySummary(candidate) {
  return (candidate?.model_summaries || []).map(item => {
    const summary = item.model_summary || {};
    const event = summary.event_policy?.selected_window_hours ?? 'N/A';
    const horizons = summary.horizon_policy?.selected_by_setup || {};
    const volatility = summary.volatility_policy?.selected_regimes;
    return `| ${item.window_index} | ${display(event, 'h')} | ${json(horizons)} | ${display(summary.score_threshold)} | ${summary.cluster_top_n ?? 'N/A'} | ${volatility ? json(volatility) : 'no selective gate'} |`;
  });
}

export function buildM11Markdown(result = {}) {
  const primary = result.best_candidate || result.primary_candidate || {};
  const metrics = primary.metrics || {};
  const stability = primary.stability || {};
  const concentration = primary.concentration || {};
  const gate = primary.promotion || result.promotion || {};
  const comparison = result.v1_comparison || {};
  const lines = [
    '# M1.1 Edge Discovery / Robust Signal Model Iteration',
    '',
    `Decision: **${result.decision || 'INSUFFICIENT_EVIDENCE'}**`,
    '',
    `- Base main SHA: \`${result.base_main_sha || 'N/A'}\``,
    `- Experiment: \`${result.experiment_id || 'N/A'}\``,
    `- Model version: \`${result.model_version || 'N/A'}\``,
    `- Source commit SHA: \`${result.commit_sha || 'N/A'}\``,
    `- Config hash: \`${result.config_hash || 'N/A'}\``,
    `- Data source: ${result.data_source || 'N/A'}`,
    `- Cost: ${display(result.cost_assumptions?.round_trip_percent, '%')} round trip; gross and net are signal-level metrics.`,
    '',
    '## Safety and holdout boundary',
    '',
    `- V1_UNCHANGED=${result.flags?.V1_UNCHANGED === true}`,
    `- V2_PRODUCTION_ENABLED=${result.flags?.V2_PRODUCTION_ENABLED === true}`,
    `- V2_SHADOW_ONLY=${result.flags?.V2_SHADOW_ONLY === true}`,
    `- AUTO_TRADING=${result.flags?.AUTO_TRADING === true}`,
    `- M2_STARTED=${result.flags?.M2_STARTED === true}`,
    `- Frozen M1 final holdout boundary: ${display(result.frozen_m1_holdout?.boundary_timestamp)}; hash retained as metadata only.`,
    `- Old M1 final holdout outcomes accessed: **${result.final_holdout_outcomes_accessed === true}**`,
    `- New M1.1 final holdout untouched: **${result.final_holdout_untouched === true}**`,
    '',
    '## Historical coverage',
    '',
    `- Target: ${result.historical_target || '180d'}`,
    `- Requested range: ${display(result.date_range?.start)} → ${display(result.date_range?.end)}`,
    '| Symbol | Loaded | Expected | Missing | Coverage | Actual start | Actual end |',
    '|---|---:|---:|---:|---:|---|---|',
  ];
  for (const item of result.coverage || []) {
    lines.push(`| ${item.symbol} | ${item.candles_loaded ?? '-'} | ${item.candles_expected ?? '-'} | ${item.missing_candles ?? '-'} | ${display(item.coverage_percent, '%')} | ${item.actual_start || '-'} | ${item.actual_end || '-'} |`);
  }
  lines.push(
    '',
    `Coverage complete: **${result.coverage_complete === true}**; symbols: ${result.symbols?.length || 0}/18.`,
    '',
    '## Bounded candidate program',
    '',
    `- Budget: ${result.candidate_search_budget || 'N/A'}`,
    `- Candidates evaluated: ${result.candidates?.length || 0}`,
    `- Primary candidate: \`${result.primary_candidate_id || 'N/A'}\``,
    `- Best candidate passing all fixed gates: \`${result.best_candidate_id || 'NONE'}\``,
    '',
    '| Candidate | Score method | Horizon policy | Event policy | Top-N | Selected OOS | Clusters | PF | Expectancy | Positive windows | Calibration | Decision |',
    '|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|',
  );
  for (const candidate of result.candidates || []) {
    lines.push(`| ${candidate.candidate_id} | ${candidate.score_method || '-'} | ${candidate.horizon_policy || '-'} | ${candidate.event_policy || '-'} | ${candidate.cluster_top_n ?? '-'} | ${candidate.selected_oos_signals ?? 0} | ${candidate.independent_oos_clusters ?? 0} | ${display(candidate.net_profit_factor)} | ${display(candidate.net_expectancy_percent, '%')} | ${candidate.positive_windows ?? 0}/${candidate.total_windows ?? '-'} | ${candidate.calibration || '-'} | ${candidate.promotion?.recommendation || '-'} |`);
  }
  lines.push(
    '',
    '## Best/reference candidate metrics',
    '',
    `- Scope: ${primary.candidate?.scope || 'bounded candidate; no scope inferred from the frozen M1 holdout'}`,
    `- Score method: ${primary.candidate?.score_method || 'N/A'}; no probability claim.`,
    `- Primary horizon policy: train-selected per setup; ${json(primary.model_summaries?.[0]?.model_summary?.horizon_policy?.selected_by_setup || {})}`,
    `- Market-event policy: ${json(primary.model_summaries?.[0]?.model_summary?.event_policy || {})}`,
    `- Cluster Top-N: ${primary.model_summaries?.[0]?.model_summary?.cluster_top_n ?? 'N/A'}`,
    `- Selected OOS signals: ${metrics.selected_oos_signals ?? 0}; independent clusters: ${metrics.independent_market_clusters ?? 0}`,
    `- Gross PF: ${display(metrics.gross_profit_factor)}; net PF: ${display(metrics.net_profit_factor)}`,
    `- Gross expectancy: ${display(metrics.gross_expectancy_percent, '%')}; net expectancy: ${display(metrics.net_expectancy_percent, '%')}`,
    `- Hit rate: ${display(metrics.hit_rate_percent, '%')}; false-positive rate: ${display(metrics.false_positive_rate_percent, '%')}`,
    `- Average MFE: ${display(metrics.avg_mfe_percent, '%')}; average MAE: ${display(metrics.avg_mae_percent, '%')}`,
    `- TP-first: ${metrics.tp_first_count || 0}; SL-first: ${metrics.sl_first_count || 0}; Neither: ${metrics.neither_count || 0}; Ambiguous: ${metrics.ambiguous_count || 0}`,
    `- Forward returns: ${json(metrics.forward_returns)}`,
    `- Signal decay: ${display(metrics.signal_decay_percent, '%')}`,
    `- Stability: median expectancy ${display(stability.median_window_expectancy_percent, '%')}; worst ${display(stability.worst_window_expectancy_percent, '%')}; median PF ${display(stability.median_window_profit_factor)}; worst PF ${display(stability.worst_window_profit_factor)}; dispersion ${display(stability.window_expectancy_dispersion_percent, '%')}`,
    `- Positive windows: ${stability.positive_windows || 0}/${stability.total_windows || 0} (${display(stability.positive_window_ratio)})`,
    `- Breadth: symbols ${metrics.symbol_breadth || 0}; directions ${Object.values(metrics.direction_breadth || {}).filter(item => item.sample_count > 0).length}; setups ${Object.values(metrics.setup_breadth || {}).filter(item => item.sample_count > 0).length}; trend regimes ${Object.values(metrics.trend_regime_breadth || {}).filter(item => item.sample_count > 0).length}; volatility regimes ${Object.values(metrics.volatility_breadth || {}).filter(item => item.sample_count > 0).length}`,
    '',
    ...metricTable('Setup family ablation', result.ablation?.setup_family),
    '',
    ...metricTable('Direction ablation', result.ablation?.direction),
    '',
    ...metricTable('Trend regime ablation', result.ablation?.trend_regime),
    '',
    ...metricTable('Volatility regime ablation', result.ablation?.volatility_regime),
    '',
    ...metricTable('Evidence-group ablation', result.ablation?.evidence_groups),
    '',
    '## Sideways / Mean Reversion diagnosis',
    '',
    `- Conclusion: **${result.sideways_diagnosis?.conclusion || 'N/A'}**`,
    `- Prior-only classifier trigger windows: ${result.sideways_diagnosis?.generation?.trigger_windows ?? 0}; Sideways triggers: ${result.sideways_diagnosis?.generation?.sideways_trigger_windows ?? 0}`,
    `- Sideways eligible setup candidates by generation: ${json(result.sideways_diagnosis?.generation?.sideways_setup_candidates || {})}`,
    `- Primary OOS Sideways candidates: ${result.sideways_diagnosis?.oos?.sideways_candidates ?? 0}; Mean Reversion: ${result.sideways_diagnosis?.oos?.sideways_mean_reversion_candidates ?? 0}`,
    `- Primary OOS score-threshold eligible: ${result.sideways_diagnosis?.oos?.score_threshold_eligible ?? 0}; volatility eligible: ${result.sideways_diagnosis?.oos?.volatility_eligible ?? 0}; volatility filtered: ${result.sideways_diagnosis?.oos?.volatility_filtered ?? 0}; cluster selected: ${result.sideways_diagnosis?.oos?.cluster_selected ?? 0}; ranking excluded: ${result.sideways_diagnosis?.oos?.ranking_excluded ?? 0}`,
    '',
    '## Train-selected policies by WFO window',
    '',
    '| Window | Event hours | Horizons by setup | Score threshold | Top-N | Volatility gate |',
    '|---:|---:|---|---:|---:|---|',
    ...formatPolicySummary(primary),
    '',
    '## BUY / SELL and setup scope',
    '',
    `- BUY: ${json(metrics.direction_breadth?.BUY || {})}`,
    `- SELL: ${json(metrics.direction_breadth?.SELL || {})}`,
    `- Trend Continuation: ${json(metrics.setup_breadth?.['Trend Continuation'] || {})}`,
    `- Mean Reversion: ${json(metrics.setup_breadth?.['Mean Reversion'] || {})}`,
    `- Breakout: ${json(metrics.setup_breadth?.Breakout || {})}`,
    '',
    '## Concentration and calibration',
    '',
    `- Max symbol cluster share: ${display(concentration.max_symbol_cluster_share)}`, 
    `- Max regime cluster share: ${display(concentration.max_regime_cluster_share)}`,
    `- Concentration risk: **${concentration.concentration_risk === true}**`,
    `- Unstable edge: **${stability.unstable_edge === true}**`,
    `- Calibration: **${metrics.score_calibration?.status || 'CALIBRATION_FAIL'}**; bins: ${metrics.score_calibration?.bin_count || 0}; monotonic: ${metrics.score_calibration?.monotonic_oos_expectancy === true}`,
    '',
    '## V1 and M1 comparators',
    '',
    `- V1 comparator horizon: ${comparison.evaluation_horizon || '1h selected OOS comparator'}`,
    `- V1 PF: ${display(comparison.v1?.net_profit_factor)}; V1 expectancy: ${display(comparison.v1?.net_expectancy_percent, '%')}`,
    `- M1 baseline PF: 0.4533; M1 baseline expectancy: -0.202178%`,
    `- M1.1 vs V1: PF delta ${display(comparison.delta?.net_profit_factor)}; expectancy delta ${display(comparison.delta?.net_expectancy_percent, '%')}`,
    `- M1.1 vs M1: PF delta ${display(result.m1_comparison?.net_profit_factor_delta)}; expectancy delta ${display(result.m1_comparison?.net_expectancy_percent_delta, '%')}; selected-signal delta ${display(result.m1_comparison?.selected_signals_delta)}`,
    `- Same candles, cost assumptions, closed-candle contract, horizons and event policy: ${comparison.same_data_contract === true}`,
    '',
    '## Promotion and limitations',
    '',
    `- Promotion gate: **${gate.recommendation || 'INSUFFICIENT_EVIDENCE'}**`,
    `- Observed: ${json(gate.observed)}`,
    `- Failures: ${gate.failures?.join(', ') || 'none'}`,
    `- Public derivatives data used: **${result.public_derivatives_data_used === true}**`,
    '- This bounded run uses candle-only public Binance Futures data. Funding/OI/spread features were not admitted without a separate point-in-time incremental OOS test.',
    '- The 180d target is intentionally frozen before the old M1 holdout boundary; symbols remain the configured 18-symbol universe and are never blacklisted by result.',
    '- All score, horizon, volatility, event and Top-N policies are fit per training window. The final holdout is reserved for a later validation phase and is not opened here.',
    '- `edge_score`, `learned_score` and calibration bins are ordering diagnostics, not win probabilities.',
    '',
  );
  return lines.join('\n');
}

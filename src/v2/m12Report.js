// Compact human-readable report for the bounded M1.2 information-gain run.

function display(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return typeof value === 'number' ? `${value}${suffix}` : String(value);
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

function comparisonLines(comparison) {
  if (!comparison) return ['- No augmented comparison was evaluated.'];
  return [
    `- Common support clusters: ${comparison.common_support_clusters ?? 0}; paired cluster count: ${comparison.paired_cluster_count ?? 0}.`,
    `- Common-support contract: ${comparison.common_support_comparison?.same_oos_support === true}; same OOS windows: ${comparison.common_support_comparison?.same_oos_windows === true}.`,
    `- Point delta net expectancy: ${display(comparison.point_estimate?.delta_net_expectancy, '%')}; delta net PF: ${display(comparison.point_estimate?.delta_net_pf)}.`,
    `- Bootstrap: ${comparison.bootstrap?.repetitions ?? 0} repetitions; delta expectancy 95% CI ${json(comparison.bootstrap?.delta_expectancy_95_ci)}; P(delta expectancy > 0)=${display(comparison.bootstrap?.p_delta_expectancy_gt_zero)}.`,
    `- Bootstrap delta PF 95% CI: ${json(comparison.bootstrap?.delta_net_pf_95_ci)}; seed: ${display(comparison.bootstrap?.seed)}.`,
  ];
}

export function buildM12Markdown(result = {}) {
  const baseline = result.baseline_summary || {};
  const diagnostic = result.diagnostic_max_delta_candidate || {};
  const comparison = diagnostic.comparison || null;
  const lines = [
    '# M1.2 Independent Information Gain / Public Derivatives',
    '',
    `Decision: **${result.decision || 'INSUFFICIENT_DERIVATIVES_DATA'}**`,
    '',
    `- Base main SHA: \`${result.base_main_sha || 'N/A'}\`; M1.1 closeout PR: #${result.m1_1_closeout?.pr_number || 'N/A'}.`,
    `- Experiment: \`${result.experiment_id || 'N/A'}\``,
    `- Model/version: \`${result.model_version || 'N/A'}\` / \`${result.feature_version || 'N/A'}\``,
    `- Source commit SHA: \`${result.commit_sha || 'N/A'}\``,
    `- Config hash: \`${result.config_hash || 'N/A'}\``,
    `- Data source: ${result.data_source || 'N/A'}`,
    `- Cost: ${display(result.cost_assumptions?.round_trip_percent, '%')} round trip; diagnostics are signal-level gross/net values.`,
    '',
    '## Safety and holdout boundary',
    '',
    `- V1_UNCHANGED=${result.flags?.V1_UNCHANGED === true}`,
    `- V2_PRODUCTION_ENABLED=${result.flags?.V2_PRODUCTION_ENABLED === true}`,
    `- V2_SHADOW_ONLY=${result.flags?.V2_SHADOW_ONLY === true}`,
    `- AUTO_TRADING=${result.flags?.AUTO_TRADING === true}`,
    `- M2_STARTED=${result.flags?.M2_STARTED === true}`,
    `- Old M1 final holdout outcomes accessed: **${result.final_holdout_outcomes_accessed === true}**`,
    `- New M1.2 final holdout untouched: **${result.final_holdout_untouched === true}**`,
    `- COMMON_SUPPORT_COMPARISON=${result.COMMON_SUPPORT_COMPARISON === true}`,
    '',
    '## Historical and derivative coverage',
    '',
    `- Target: ${result.historical_target || '180d × 18 symbols'}`,
    `- Requested range: ${display(result.date_range?.start)} → ${display(result.date_range?.end)}`,
    `- Candle coverage complete: **${result.coverage_complete === true}**; symbols: ${result.symbols?.length || 0}/18.`,
    '',
    '| Family | Admitted | Coverage threshold | Notes |',
    '|---|---:|---:|---|',
  ];
  for (const family of Object.values(result.data_admission?.families || {})) {
    lines.push(`| ${family.family} | ${family.admitted === true} | ${display(family.coverage_threshold_percent, '%')} | ${family.status} |`);
  }
  lines.push(
    '',
    `- Admitted families: ${json(result.admitted_families || [])}`,
    `- Rejected families: ${json(result.rejected_families || [])}`,
    `- Liquidations: ${result.data_admission?.liquidation?.status || 'N/A'}`,
    `- Order book: ${result.data_admission?.orderbook?.status || 'N/A'}`,
    `- OI sampling: ${result.derivative_data?.oi_sampling || 'N/A'}`,
    '',
    '## Frozen baseline and predeclared candidates',
    '',
    `- Frozen candle-only baseline: \`${result.frozen_candle_baseline?.candidate_id || 'N/A'}\``,
    `- Candidate budget: ${result.candidate_search_budget || 'N/A'}`,
    `- Diagnostic largest observed delta (not a selection rule): \`${result.diagnostic_max_delta_candidate_id || 'NONE'}\``,
    '',
    '| Candidate | Families | Status | Selected OOS | Clusters | Net PF | Net expectancy | Gain gate | Absolute gate |',
    '|---|---|---|---:|---:|---:|---:|---|---|',
  );
  for (const candidate of result.candidates || []) {
    lines.push(`| ${candidate.candidate_id} | ${(candidate.derivative_families || []).join(', ') || 'candle-only'} | ${candidate.status || '-'} | ${candidate.selected_oos_signals ?? 0} | ${candidate.independent_oos_clusters ?? 0} | ${display(candidate.net_profit_factor)} | ${display(candidate.net_expectancy_percent, '%')} | ${candidate.independent_information_gain === true} | ${candidate.absolute_promotion?.pass === true} |`);
  }
  lines.push(
    '',
    '## Baseline and augmented comparison',
    '',
    `- Baseline net PF: ${display(baseline.net_profit_factor)}; net expectancy: ${display(baseline.net_expectancy_percent, '%')}; calibration: ${baseline.calibration || 'N/A'}.`,
    `- Diagnostic augmented candidate: \`${diagnostic.candidate_id || 'NONE'}\`; information gain: ${diagnostic.independent_information_gain === true}.`,
    ...comparisonLines(comparison),
    '',
    '## Information-family ablation',
    '',
    '| Family | Candidate IDs | Best candidate | Gain gate |',
    '|---|---|---|---:|',
  );
  for (const family of Object.values(result.feature_family_ablation || {})) {
    lines.push(`| ${family.family} | ${(family.candidate_ids || []).join(', ') || '-'} | ${family.best_candidate_id || '-'} | ${family.independent_information_gain === true} |`);
  }
  lines.push(
    '',
    ...metricTable('Direction ablation', result.ablation?.direction),
    '',
    ...metricTable('Trend regime ablation', result.ablation?.trend_regime),
    '',
    ...metricTable('Volatility regime ablation', result.ablation?.volatility_regime),
    '',
    ...metricTable('Setup-family ablation', result.ablation?.setup_family),
    '',
    '## Required failure-mode checks',
    '',
    `- BUY/SELL slices are retained: ${json({ BUY: result.baseline_metrics?.direction_breadth?.BUY, SELL: result.baseline_metrics?.direction_breadth?.SELL })}`,
    `- Sideways/Mean Reversion diagnosis: **${result.sideways_diagnosis?.conclusion || 'N/A'}**`,
    `- Sideways mean-reversion candidates: ${result.sideways_diagnosis?.generation?.sideways_mean_reversion_candidates ?? 0}; no post-hoc whitelist or threshold change was applied.`,
    '',
    '## Cost sensitivity (diagnostic only)',
    '',
    '| Round-trip cost | Candidate count | Selection impact |',
    '|---:|---:|---|',
  );
  for (const item of result.cost_sensitivity || []) {
    lines.push(`| ${display(item.round_trip_cost_percent, '%')} | ${Object.keys(item.candidates || {}).length} | ${item.selection_use || '-'} |`);
  }
  lines.push(
    '',
    '## WFO, calibration and concentration',
    '',
    `- WFO windows: ${result.wfo?.window_count ?? 0}; purge: ${result.wfo?.options?.purgeHours ?? 'N/A'}h; embargo: ${result.wfo?.options?.embargoHours ?? 'N/A'}h; label horizon: ${result.wfo?.options?.labelHorizonHours ?? 'N/A'}h.`,
    `- Baseline calibration: **${baseline.calibration || 'N/A'}**; augmented diagnostic calibration: **${diagnostic.calibration || 'N/A'}**.`,
    `- Baseline concentration: ${json(baseline.concentration || {})}`,
    `- Augmented concentration: ${json(diagnostic.concentration || {})}`,
    `- Final holdout: ${json(result.final_holdout || {})}`,
    '',
    '## Decision and limitations',
    '',
    `- Information-gain decision: **${result.decision || 'N/A'}**`,
    `- Known limitations: ${json(result.known_limitations || [])}`,
    '',
  );
  return lines.join('\n');
}

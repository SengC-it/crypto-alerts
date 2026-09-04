// Human-readable companion report for the bounded M1.3 research run.

function display(value, suffix = '') {
  if (value === null || value === undefined || Number.isNaN(value)) return 'N/A';
  return String(value) + suffix;
}

function json(value) {
  return JSON.stringify(value ?? null);
}

function code(value) {
  return String.fromCharCode(96) + String(value ?? 'N/A') + String.fromCharCode(96);
}

function candidateLine(candidate) {
  const metrics = candidate.metrics || {};
  const incremental = candidate.incremental_gate || {};
  const absolute = candidate.absolute_gate || {};
  return '| ' + (candidate.candidate_id || '-') + ' | ' + (candidate.family || '-') + ' | '
    + (candidate.status || '-') + ' | ' + (metrics.selected_oos_signals ?? 0) + ' | '
    + (metrics.independent_market_events ?? 0) + ' | ' + display(metrics.net_profit_factor) + ' | '
    + display(metrics.net_expectancy_percent, '%') + ' | ' + (incremental.pass === true)
    + ' | ' + (absolute.pass === true) + ' |';
}

export function buildM13Markdown(result = {}) {
  const best = result.best_candidate || {};
  const bestMetrics = best.metrics || {};
  const comparison = best.comparison || {};
  const bootstrap = comparison.bootstrap || {};
  const lines = [
    '# M1.3 Cross-Sectional / Relative-Value Alpha Discovery',
    '',
    'Decision: **' + (result.decision || 'INSUFFICIENT_CROSS_SECTIONAL_EVIDENCE') + '**',
    '',
    '- Branch: ' + code(result.branch) + '; Draft PR: #' + (result.draft_pr_number ?? 'N/A') + ' (never merged).',
    '- Base main SHA: ' + code(result.base_main_sha) + '; experiment source SHA: ' + code(result.experiment_source_sha) + '.',
    '- Experiment: ' + code(result.experiment_id) + '; config hash: ' + code(result.config_hash) + '.',
    '- Model/version: ' + code(result.model_version) + ' / ' + code(result.feature_version) + '.',
    '- Data: ' + (result.data_source || 'N/A') + '; target ' + (result.historical_target || 'N/A') + '.',
    '',
    '## Safety and holdout',
    '',
    '- Flags: ' + json(result.flags || {}),
    '- Previous final holdout boundary/hash retained as metadata only: ' + json(result.previous_final_holdout || {}) + '.',
    '- Previous holdout outcomes accessed: **' + (result.previous_final_holdout_outcomes_accessed === true) + '**.',
    '- New final holdout untouched: **' + (result.final_holdout_untouched === true) + '**; metadata: ' + json(result.final_holdout || {}) + '.',
    '- V2 production/deployment/auto-trading changes: **false**.',
    '',
    '## Data and event contract',
    '',
    '- Date range: ' + display(result.date_range?.start) + ' → ' + display(result.date_range?.end) + '; as-of ' + display(result.date_range?.as_of) + '.',
    '- Coverage: ' + (result.coverage_complete === true) + '; symbols ' + (result.symbols?.length || 0) + '/18; valid snapshots ' + (result.valid_snapshots ?? 0) + '; rejected breadth snapshots ' + (result.rejected_snapshots ?? 0) + '.',
    '- Independent events: ' + (result.independent_market_events ?? 0) + '; event definition: ' + (result.event_definitions?.independent || 'N/A') + '.',
    '- Snapshot definition: ' + (result.event_definitions?.snapshot || 'N/A') + '; minimum breadth: ' + (result.minimum_valid_symbols ?? 'N/A') + '.',
    '- Admitted derivative families: ' + json(result.data_admission?.admitted_families || []) + '; X11 status: ' + (result.x11_status || 'N/A') + '.',
    '',
    '## Predeclared candidate matrix',
    '',
    '| Candidate | Family | Status | Selected OOS | Events | Net PF | Net expectancy | Incremental gate | Absolute gate |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|',
  ];
  for (const candidate of result.candidates || []) lines.push(candidateLine(candidate));
  lines.push(
    '',
    '## Best candidate and common-support comparison',
    '',
    '- Best candidate: ' + code(best.candidate_id) + '; direction: ' + (best.direction || 'BUY and SELL') + '; primary horizon: ' + (best.primary_horizon_hours ?? 'N/A') + 'h.',
    '- Metrics: selected ' + (bestMetrics.selected_oos_signals ?? 0) + '; independent events ' + (bestMetrics.independent_market_events ?? 0) + '; net PF ' + display(bestMetrics.net_profit_factor) + '; net expectancy ' + display(bestMetrics.net_expectancy_percent, '%') + '; calibration ' + (bestMetrics.score_calibration?.status || 'N/A') + '.',
    '- Common support events: ' + (comparison.paired_independent_market_events ?? 0) + '; support outcome-independent: ' + (comparison.common_support_comparison?.common_support_outcome_independent === true) + '.',
    '- Point delta net expectancy: ' + display(comparison.point_estimate?.delta_net_expectancy_percent, '%') + '; bootstrap unit: ' + (bootstrap.unit || 'N/A') + '; reps: ' + (bootstrap.repetitions ?? 0) + '; seed: ' + (bootstrap.seed ?? 'N/A') + '.',
    '- Delta expectancy 95% CI: ' + json(bootstrap.delta_expectancy_95_ci) + '; P(delta > 0): ' + display(bootstrap.p_delta_expectancy_gt_zero) + '.',
    '- Abstention outcome convention: ' + (comparison.common_support_comparison?.abstention_outcome ?? 'N/A') + '.',
    '',
    '## WFO, costs and diagnostics',
    '',
    '- WFO windows: ' + (result.wfo?.window_count ?? 0) + '; purge ' + (result.wfo?.options?.purgeHours ?? 'N/A') + 'h; embargo ' + (result.wfo?.options?.embargoHours ?? 'N/A') + 'h; label horizon ' + (result.wfo?.options?.labelHorizonHours ?? 'N/A') + 'h.',
    '- Costs: ' + display(result.cost_assumptions?.round_trip_percent, '%') + ' round trip; sensitivity ' + json(result.cost_sensitivity || []) + '; sensitivity did not affect selection.',
    '- Factor correlations and stress/monthly slices are diagnostic only: ' + json(result.diagnostics || {}) + '.',
    '',
    '## Gates and limitations',
    '',
    '- Incremental gate: ' + json(best.incremental_gate || {}) + '.',
    '- Absolute gate: ' + json(best.absolute_gate || {}) + '.',
    '- Known limitations: ' + json(result.known_limitations || []) + '.',
    '',
  );
  return lines.join('\n');
}

import { hashConfig } from '../lineage.js';

export const M16_BASE_MAIN_SHA = '6361418a35e3d8f7e5aa1c6e5ce87bfb38830a2a';
export const M16_DECISIONS = Object.freeze([
  'CONTINUE_DIRECTIONAL_ALPHA_WITH_NEW_INFORMATION_DOMAIN',
  'PIVOT_TO_NON_DIRECTIONAL_MARKET_EVENT_RESEARCH',
  'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM',
  'INSUFFICIENT_PROJECT_EVIDENCE',
]);

export const M16_ACCEPTED_REPORTS = Object.freeze({
  M1: 'reports/m1-final.json',
  M1_1: 'reports/m1-1-final.json',
  M1_2: 'reports/m1-2-final-0.1.1.json',
  M1_3: 'reports/m1-3-final.json',
  M1_4: 'reports/m1-4-alpha-feasibility-0.1.1.json',
  M1_5: 'reports/m1-5-causal-sparsification-validation-0.1.1.json',
});

export const M16_INVALIDATED_REPORTS = Object.freeze([
  'reports/m1-5-causal-sparsification-validation-0.1.0.json',
]);

export const M16_SAFETY_FLAGS = Object.freeze({
  SIGNAL_ONLY: true,
  USER_DECIDES_ENTRY: true,
  USER_DECIDES_POSITION_SIZE: true,
  USER_DECIDES_EXIT: true,
  V1_UNCHANGED: true,
  V2_PRODUCTION_ENABLED: false,
  AUTO_TRADING: false,
  PRIVATE_TRADING_API: false,
  M2_STARTED: false,
});

export const M16_INFORMATION_DOMAINS = Object.freeze([
  { domain: '1h OHLCV', status: 'TESTED', feasibility: 'AVAILABLE' },
  { domain: 'technical structure', status: 'TESTED', feasibility: 'AVAILABLE' },
  { domain: 'market regime', status: 'TESTED', feasibility: 'AVAILABLE' },
  { domain: 'cross-sectional ranks', status: 'TESTED', feasibility: 'AVAILABLE' },
  { domain: 'relative/residual momentum', status: 'TESTED', feasibility: 'AVAILABLE' },
  { domain: 'lead-lag', status: 'TESTED', feasibility: 'AVAILABLE' },
  { domain: 'funding', status: 'TESTED', feasibility: 'PARTIAL' },
  { domain: 'open interest', status: 'TESTED', feasibility: 'PARTIAL' },
  { domain: 'basis/premium', status: 'TESTED', feasibility: 'PARTIAL' },
  { domain: 'taker flow', status: 'TESTED', feasibility: 'PARTIAL' },
  { domain: 'true historical order book', status: 'NOT_AVAILABLE', feasibility: 'VENDOR_OR_ARCHIVE_REQUIRED' },
  { domain: 'trade-level microstructure', status: 'PARTIALLY_AVAILABLE', feasibility: 'TICK_DATA_AND_PIT_AUDIT_REQUIRED' },
  { domain: 'liquidation flow', status: 'NOT_AVAILABLE', feasibility: 'VENDOR_OR_ARCHIVE_REQUIRED' },
  { domain: 'sub-hour event structure', status: 'NOT_AVAILABLE', feasibility: 'SUB_HOUR_DATA_AND_PIT_AUDIT_REQUIRED' },
  { domain: 'external cross-market information', status: 'AVAILABLE_AND_UNTESTED', feasibility: 'PIT_ALIGNED_DATA_REQUIRED' },
]);

function get(obj, path, fallback = null) {
  let value = obj;
  for (const key of path.split('.')) value = value?.[key];
  return value ?? fallback;
}

function isoRange(range) {
  if (!range) return null;
  const start = typeof range.start === 'number' ? new Date(range.start).toISOString() : range.start;
  const endValue = range.end ?? range.end_timestamp;
  const end = typeof endValue === 'number' ? new Date(endValue).toISOString() : endValue;
  return { start, end };
}

function positiveWindows(positive, total) {
  return `${positive ?? 0}/${total ?? 0}`;
}

function stageRow({ stage, question, report, dataset, dateRange, symbols, candidateCount, metrics, windows, bootstrap, calibration, promotion, decision, limitations, hashes }) {
  return {
    stage,
    research_question: question,
    dataset,
    time_range: isoRange(dateRange),
    symbols,
    candidate_count: candidateCount,
    primary_oos_events: metrics?.events ?? null,
    gross_expectancy_percent: metrics?.gross_expectancy_percent ?? null,
    net_expectancy_percent: metrics?.net_expectancy_percent ?? null,
    gross_pf: metrics?.gross_pf ?? null,
    net_pf: metrics?.net_pf ?? null,
    positive_windows: windows,
    bootstrap_ci: bootstrap ?? 'not reported in accepted final artifact',
    calibration: calibration ?? 'NOT_REPORTED',
    promotion_result: promotion ?? 'NOT_REPORTED',
    final_decision: decision,
    known_methodological_limitations: limitations ?? [],
    evidence_hashes: hashes,
    accepted_final_only: true,
    report_reference: report,
  };
}

function reportHashes(report) {
  return {
    source_sha: report.experiment_source_sha ?? report.source_sha ?? report.commit_sha ?? null,
    config_hash: report.config_hash ?? null,
  };
}

function m1Summary(report) {
  const metrics = report.metrics?.v2 ?? {};
  const promotion = report.promotion ?? {};
  const benchmark = report.benchmark ?? {};
  return stageRow({
    stage: 'M1',
    question: 'Can the bounded V2 quality model meet predeclared OOS promotion gates?',
    report: M16_ACCEPTED_REPORTS.M1,
    dataset: benchmark.data_source,
    dateRange: benchmark.date_range,
    symbols: benchmark.symbols?.length ?? null,
    candidateCount: report.candidate_count,
    metrics: { events: metrics.independent_market_clusters, ...metrics, gross_pf: metrics.gross_profit_factor, net_pf: metrics.net_profit_factor },
    windows: positiveWindows(promotion.observed?.positive_windows, promotion.observed?.oos_windows),
    calibration: report.calibration?.status,
    promotion: promotion.recommendation,
    decision: promotion.recommendation,
    limitations: ['public 1h Binance archive only', 'research-only shadow evaluation', 'no account-return claim'],
    hashes: reportHashes(report),
  });
}

function m11Summary(report) {
  const metrics = report.primary_candidate?.metrics ?? {};
  return stageRow({
    stage: 'M1.1',
    question: 'Does a bounded edge-discovery family produce a robust, stable OOS directional lane?',
    report: M16_ACCEPTED_REPORTS.M1_1,
    dataset: report.data_source,
    dateRange: report.date_range,
    symbols: report.symbols?.length ?? null,
    candidateCount: report.candidates?.length ?? report.candidate_search_budget,
    metrics: { events: metrics.independent_market_clusters, ...metrics, gross_pf: metrics.gross_profit_factor, net_pf: metrics.net_profit_factor },
    windows: positiveWindows(report.stability?.positive_windows, report.stability?.total_windows),
    calibration: report.calibration?.status,
    promotion: report.promotion?.recommendation,
    decision: report.decision,
    limitations: report.known_limitations,
    hashes: reportHashes(report),
  });
}

function m12Summary(report) {
  const metrics = report.baseline_summary ?? report.baseline_metrics ?? {};
  return stageRow({
    stage: 'M1.2',
    question: 'Do admitted derivative information families add independent information gain to the frozen baseline?',
    report: M16_ACCEPTED_REPORTS.M1_2,
    dataset: report.data_source,
    dateRange: report.date_range,
    symbols: report.symbols?.length ?? null,
    candidateCount: report.candidates?.length ?? report.candidate_search_budget,
    metrics: { events: metrics.independent_oos_clusters, ...metrics, gross_pf: metrics.gross_profit_factor, net_pf: metrics.net_profit_factor },
    windows: positiveWindows(metrics.positive_windows, metrics.total_windows),
    calibration: metrics.calibration,
    promotion: metrics.absolute_promotion?.pass ? 'PASS' : 'REJECT',
    decision: report.decision,
    limitations: report.known_limitations,
    hashes: reportHashes(report),
  });
}

function m13Summary(report) {
  const metrics = report.best_candidate?.metrics ?? {};
  const comparison = report.best_candidate?.comparison ?? report.COMMON_SUPPORT_COMPARISON?.comparison ?? {};
  return stageRow({
    stage: 'M1.3',
    question: 'Does cross-sectional relative-value information produce robust incremental directional alpha?',
    report: M16_ACCEPTED_REPORTS.M1_3,
    dataset: report.data_source,
    dateRange: report.date_range,
    symbols: report.symbols?.length ?? null,
    candidateCount: report.candidates?.length ?? report.candidate_search_budget,
    metrics: { events: metrics.independent_market_events, ...metrics, gross_pf: metrics.gross_profit_factor, net_pf: metrics.net_profit_factor },
    windows: positiveWindows(metrics.stability?.positive_windows, metrics.stability?.total_windows),
    bootstrap: comparison.bootstrap ? { ci95: comparison.bootstrap.delta_expectancy_95_ci, p_delta_gt_zero: comparison.bootstrap.p_delta_expectancy_gt_zero } : null,
    calibration: metrics.calibration?.status,
    promotion: report.best_candidate?.incremental_gate?.pass ? 'PASS' : 'REJECT',
    decision: report.decision,
    limitations: report.known_limitations,
    hashes: reportHashes(report),
  });
}

function m14Summary(report) {
  const lane = report.review_lanes?.find(item => item.lane_id === report.primary_lane) ?? {};
  const metrics = lane.summary ?? {};
  return stageRow({
    stage: 'M1.4',
    question: 'Is any accepted directional lane gross-feasible and is the M1.4 density finding independently actionable?',
    report: M16_ACCEPTED_REPORTS.M1_4,
    dataset: report.data_source,
    dateRange: report.date_range,
    symbols: report.symbols?.length ?? null,
    candidateCount: Object.keys(report.stage_evidence ?? {}).length,
    metrics: {
      events: metrics.independent_events,
      gross_expectancy_percent: report.primary_0_14_percent_gross_result ?? metrics.gross_expectancy_percent,
      net_expectancy_percent: report.primary_0_14_percent_net_result ?? metrics.net_expectancy_percent,
      gross_pf: metrics.gross_pf,
      net_pf: metrics.net_pf,
    },
    windows: positiveWindows(metrics.net_positive_windows, metrics.total_windows),
    bootstrap: metrics.gross_bootstrap ? { ci95: metrics.gross_bootstrap.ci95, p_gt_zero: metrics.gross_bootstrap.p_gt_zero } : null,
    calibration: lane.calibration,
    promotion: report.directional_net_edge ? 'PASS' : 'REJECT',
    decision: report.decision,
    limitations: report.known_limitations,
    hashes: { ...reportHashes(report), canonical_review_plan_hash: report.canonical_review_plan_hash },
  });
}

function m15Summary(report) {
  const policy = report.policies?.CAUSAL_BUCKET_CLOSE_TOP1_PER_DIRECTION ?? {};
  return stageRow({
    stage: 'M1.5',
    question: 'Does the corrected point-in-time, causal, fresh validation confirm the M1.4 sparsification finding?',
    report: M16_ACCEPTED_REPORTS.M1_5,
    dataset: report.data_source,
    dateRange: report.validation,
    symbols: report.configured_symbols?.length ?? null,
    candidateCount: Object.keys(report.policies ?? {}).length,
    metrics: { events: policy.independent_events, ...policy, gross_pf: policy.gross_pf, net_pf: policy.net_pf },
    windows: positiveWindows(policy.net_positive_windows, policy.total_windows),
    bootstrap: policy.standard_bootstrap ? { net_ci95: policy.standard_bootstrap.net.ci95, net_p_gt_zero: policy.standard_bootstrap.net.p_gt_zero } : null,
    calibration: report.calibration?.status,
    promotion: report.gates?.c1_confirmation?.pass ? 'PASS' : 'REJECT',
    decision: report.decision,
    limitations: report.limitations,
    hashes: { ...reportHashes(report), validation_plan_hash: report.validation?.validation_plan_hash, validation_event_window_map_hash: report.validation?.validation_event_window_map_hash },
  });
}

export function buildAcceptedEvidenceLedger(reports) {
  return [
    m1Summary(reports.M1),
    m11Summary(reports.M1_1),
    m12Summary(reports.M1_2),
    m13Summary(reports.M1_3),
    m14Summary(reports.M1_4),
    m15Summary(reports.M1_5),
  ];
}

export function assertAcceptedArtifactPaths(paths) {
  const expected = Object.values(M16_ACCEPTED_REPORTS).sort();
  const actual = [...paths].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('M1.6 evidence ledger must contain exactly the accepted final artifacts');
  }
  if (actual.some(path => M16_INVALIDATED_REPORTS.includes(path))) {
    throw new Error('M1.6 must exclude invalidated M1.5 0.1.0');
  }
  return true;
}

export function breakEvenRoundTripCost(grossExpectancyPercent) {
  return Number.isFinite(grossExpectancyPercent) && grossExpectancyPercent > 0
    ? grossExpectancyPercent
    : 'NO_POSITIVE_GROSS_EDGE';
}

export function classifyCostFeasibility({ grossExpectancyPercent, netExpectancyPercent, roundTripCostPercent = 0.14 }) {
  if (!Number.isFinite(grossExpectancyPercent) || grossExpectancyPercent <= 0) return 'NO_MEANINGFUL_GROSS_EDGE';
  if (netExpectancyPercent > 0) return 'EDGE_SURVIVES_REALISTIC_COST';
  if (roundTripCostPercent >= grossExpectancyPercent) return 'EDGE_EXISTS_ONLY_BEFORE_COST';
  return 'EDGE_SURVIVES_REALISTIC_COST';
}

export function resolveM16Decision({ directionalAlphaSupported = false, eventAlertProductValue = false, evidenceSufficient = true } = {}) {
  if (!evidenceSufficient) return 'INSUFFICIENT_PROJECT_EVIDENCE';
  if (directionalAlphaSupported) return 'CONTINUE_DIRECTIONAL_ALPHA_WITH_NEW_INFORMATION_DOMAIN';
  if (eventAlertProductValue) return 'PIVOT_TO_NON_DIRECTIONAL_MARKET_EVENT_RESEARCH';
  return 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM';
}

export function assertSingleProjectDecision(decision) {
  if (!M16_DECISIONS.includes(decision)) throw new Error(`Invalid M1.6 project decision: ${decision}`);
  return [decision];
}

export function assertM16Boundary(boundary = {}) {
  const forbidden = ['openedHoldoutOutcomes', 'generatedCandidates', 'productionRouteChanges', 'v2ProductionEnabled', 'autoTrading', 'm2Started'];
  if (forbidden.some(key => boundary[key])) throw new Error('M1.6 boundary violation');
  return true;
}

export function buildCostLanes({ m1, m11, m12, m13, m14, m15 }) {
  const lanes = [
    ['M1 V2 primary', m1.metrics.v2],
    ['M1.1 primary', m11.primary_candidate.metrics],
    ['M1.2 C0 frozen baseline', m12.baseline_summary],
    ['M1.2 C7 diagnostic', m12.diagnostic_max_delta_candidate],
    ['M1.3 X8 primary', m13.best_candidate.metrics],
    ['M1.4 R3 primary', m14.review_lanes?.find(item => item.lane_id === m14.primary_lane)?.summary],
    ['M1.4 density diagnostic', m14.density_feasibility?.TOP1_PER_4H_EVENT_PER_DIRECTION],
    ['M1.5 C1 causal confirmation', m15.policies?.CAUSAL_BUCKET_CLOSE_TOP1_PER_DIRECTION],
  ];
  return lanes.map(([lane, metrics = {}]) => {
    const gross = metrics.gross_expectancy_percent;
    const net = metrics.net_expectancy_percent;
    return {
      lane,
      gross_expectancy_percent: gross,
      net_expectancy_percent: net,
      cost_drag_percent: Number.isFinite(gross) && Number.isFinite(net) ? gross - net : null,
      gross_pf: metrics.gross_pf ?? metrics.gross_profit_factor ?? null,
      net_pf: metrics.net_pf ?? metrics.net_profit_factor ?? null,
      break_even_round_trip_cost_percent: breakEvenRoundTripCost(gross),
      classification: classifyCostFeasibility({ grossExpectancyPercent: gross, netExpectancyPercent: net }),
    };
  });
}

export function buildM16Report({ reports, reportFileHashes = {}, sourceSha = 'UNCOMMITTED', generatedAt = new Date().toISOString() }) {
  assertAcceptedArtifactPaths(Object.values(M16_ACCEPTED_REPORTS));
  assertM16Boundary({
    openedHoldoutOutcomes: false,
    generatedCandidates: false,
    productionRouteChanges: false,
    v2ProductionEnabled: false,
    autoTrading: false,
    m2Started: false,
  });
  const decision = resolveM16Decision({ directionalAlphaSupported: false, eventAlertProductValue: false, evidenceSufficient: true });
  const ledger = buildAcceptedEvidenceLedger(reports);
  return {
    report_version: 'm1.6-profitability-feasibility-0.1.0',
    generated_at: generatedAt,
    base_main_sha: M16_BASE_MAIN_SHA,
    source_sha: sourceSha,
    accepted_final_artifacts: M16_ACCEPTED_REPORTS,
    invalidated_excluded_artifacts: M16_INVALIDATED_REPORTS,
    accepted_artifact_sha256: reportFileHashes,
    evidence_ledger: ledger,
    failure_taxonomy: [
      { code: 'A', category: 'NO_PREDICTIVE_INFORMATION', strength: 'MODERATE', stage_references: ['M1', 'M1.1', 'M1.2', 'M1.3', 'M1.5'], evidence: 'Repeated rejected OOS lanes; not an impossibility claim.' },
      { code: 'B', category: 'GROSS_EDGE_TOO_WEAK_FOR_COST', strength: 'STRONG', stage_references: ['M1.1', 'M1.2', 'M1.3', 'M1.4', 'M1.5'], evidence: 'Positive gross lanes remain below fixed 0.14% cost or have no positive gross edge.' },
      { code: 'C', category: 'NON_STATIONARY_EDGE', strength: 'STRONG', stage_references: ['M1.1', 'M1.3', 'M1.4', 'M1.5'], evidence: 'Unstable windows and fresh confirmation decay.' },
      { code: 'D', category: 'DIRECTIONAL_ASYMMETRY', strength: 'MODERATE', stage_references: ['M1', 'M1.1', 'M1.5'], evidence: 'Observed slices are diagnostic; no predeclared replicated BUY-only rule.' },
      { code: 'E', category: 'SIGNAL_DENSITY_CORRELATION', strength: 'MODERATE', stage_references: ['M1.4', 'M1.5'], evidence: 'Retrospective density view differs from raw stream and causal view.' },
      { code: 'F', category: 'SCORE_CALIBRATION_FAILURE', strength: 'STRONG', stage_references: ['M1', 'M1.1', 'M1.2', 'M1.3', 'M1.5'], evidence: 'Accepted primary lanes repeatedly report CALIBRATION_FAIL.' },
      { code: 'G', category: 'SYMBOL_CONCENTRATION', strength: 'STRONG', stage_references: ['M1.3', 'M1.4', 'M1.5'], evidence: 'Concentration gates fail or diagnostic lanes exceed the 0.30 threshold.' },
      { code: 'H', category: 'REGIME_CONCENTRATION', strength: 'WEAK', stage_references: ['M1.1', 'M1.2'], evidence: 'Bull/Bear shares are imbalanced but not the primary hard failure.' },
      { code: 'I', category: 'CAUSAL_TRANSLATION_FAILURE', strength: 'STRONG', stage_references: ['M1.4', 'M1.5'], evidence: 'M1.4 retrospective density result does not survive corrected causal fresh validation.' },
      { code: 'J', category: 'DATA_DOMAIN_LIMITATION', strength: 'MODERATE', stage_references: ['M1', 'M1.1', 'M1.2', 'M1.3', 'M1.4', 'M1.5'], evidence: 'Only public 1h/derivative aggregates were accepted; missing domains are not asserted to contain alpha.' },
    ],
    cost_feasibility: buildCostLanes({
      m1: reports.M1,
      m11: reports.M1_1,
      m12: reports.M1_2,
      m13: reports.M1_3,
      m14: reports.M1_4,
      m15: reports.M1_5,
    }),
    temporal_stability: {
      discovery_stage: 'M1.4',
      confirmation_stage: 'M1.5',
      discovery: reports.M1_5.discovery_retention.frozen_m14_reference,
      fresh_d1: reports.M1_5.discovery_retention.fresh_d1,
      discovery_to_fresh_delta: reports.M1_5.discovery_retention.fresh_delta_vs_m14,
      causality_gap: reports.M1_5.causality_gap,
      conclusion: 'Apparent density edge decays under fresh, causal validation; net confirmation fails.'
    },
    directional_feasibility: {
      classification: 'POST_HOC_ONLY',
      buy_only_selection_allowed: false,
      evidence: 'BUY/SELL slices are diagnostic and cannot authorize a BUY-only rule after fresh outcomes.'
    },
    score_calibration: {
      classification: 'SCORE_NOT_DECISION_GRADE',
      primary_calibration_failures: ['M1', 'M1.1', 'M1.2', 'M1.3', 'M1.5'],
      isolated_diagnostic_passes_are_not_independent_proof: true,
    },
    information_domains: M16_INFORMATION_DOMAINS,
    multiplicity: {
      primary_research_stages: 6,
      candidate_families_or_variants: { M1: 10656, M1_1: '11/20', M1_2: '10/16', M1_3: '12/12', M1_4: '4 lanes plus 3 density views', M1_5: '4 fixed policies' },
      diagnostic_policies: ['M1.2 C7', 'M1.3 X8', 'M1.4 density views', 'M1.5 D1/D2'],
      fresh_confirmations: 1,
      interpretation: 'Researcher degrees of freedom and diagnostic selection mean winners are not independent proof; accumulation is classified conservatively.',
    },
    event_magnitude_evidence: {
      source_stage: 'M1.4',
      directional_alpha: false,
      horizon_hours: reports.M1_4.event_alert_utility.primary_horizon_hours,
      absolute_return_enrichment_percent: reports.M1_4.event_alert_utility.delta_8h_absolute_return,
      ci95: reports.M1_4.event_alert_utility.delta_8h_ci95,
      event_concentration: reports.M1_4.event_alert_utility.max_symbol_event_concentration,
      gate_pass: reports.M1_4.event_alert_utility.pass,
      product_value: 'Potentially useful as a separate human-facing market-event alert research question, but the accepted gate is false because of concentration; no deployment or pivot is authorized here.',
    },
    decision,
    decision_count: assertSingleProjectDecision(decision).length,
    future_recommendation: {
      closed_directional_lines: ['X8 cross-sectional lead-lag', 'signal sparsification', 'basic derivative augmentation', 'current cross-sectional directional line'],
      focus: ['signal product quality', 'alert UX', 'observability', 'data integrity', 'performance monitoring'],
      new_information_domain: null,
      implementation_authorized: false,
    },
    safety_flags: M16_SAFETY_FLAGS,
    holdout_outcomes_opened: false,
    new_candidates_generated: false,
    production_route_changes: false,
    report_hash: hashConfig({ base_main_sha: M16_BASE_MAIN_SHA, decision, ledger, source_sha: sourceSha }),
  };
}

export function buildM16Markdown(report) {
  const lines = [
    '# M1.6 — Project-Level Profitability Feasibility Review',
    '',
    `- Base main SHA: \`${report.base_main_sha}\``,
    `- Source SHA: \`${report.source_sha}\``,
    `- Decision: \`${report.decision}\``,
    '- Scope: accepted research evidence only; no alpha search, deployment, V2 enablement, or M2.',
    '',
    '## Accepted evidence ledger',
    '',
    '| Stage | Primary OOS events | Gross exp % | Net exp % | Gross PF | Net PF | Positive windows | Calibration | Promotion | Decision |',
    '|---|---:|---:|---:|---:|---:|---|---|---|---|',
    ...report.evidence_ledger.map(row => `| ${row.stage} | ${row.primary_oos_events ?? '—'} | ${row.gross_expectancy_percent ?? '—'} | ${row.net_expectancy_percent ?? '—'} | ${row.gross_pf ?? '—'} | ${row.net_pf ?? '—'} | ${row.positive_windows} | ${row.calibration} | ${row.promotion_result} | ${row.final_decision} |`),
    '',
    'Only the accepted final artifacts are included. The invalidated M1.5 0.1.0 run is excluded; final holdout outcomes were not opened.',
    '',
    '## Failure taxonomy',
    '',
    ...report.failure_taxonomy.map(item => `- **${item.code}. ${item.category}** — ${item.strength}; ${item.evidence} (stages: ${item.stage_references.join(', ')}).`),
    '',
    '## Cost and stability conclusions',
    '',
    `Fixed research cost remains 0.14%. Break-even cost is the gross mean expectancy; no cost or horizon was changed. ${report.temporal_stability.conclusion}`,
    `M1.4 → M1.5 expectancy delta: ${report.temporal_stability.discovery_to_fresh_delta.net_expectancy_percent} percentage points; PF delta: ${report.temporal_stability.discovery_to_fresh_delta.net_pf}.`,
    '',
    '## Direction, score, and information domains',
    '',
    `Directional classification: ${report.directional_feasibility.classification}; BUY-only selection allowed: ${report.directional_feasibility.buy_only_selection_allowed}.`,
    `Score calibration: ${report.score_calibration.classification}.`,
    `Tested domains: ${report.information_domains.filter(item => item.status === 'TESTED').map(item => item.domain).join(', ')}.`,
    `Untested/unavailable domains: ${report.information_domains.filter(item => item.status !== 'TESTED').map(item => `${item.domain} (${item.status})`).join(', ')}. No missing domain is claimed to contain alpha.`,
    '',
    '## M1.4 event magnitude evidence',
    '',
    `8h absolute-return enrichment: ${report.event_magnitude_evidence.absolute_return_enrichment_percent} percentage points; CI95 ${JSON.stringify(report.event_magnitude_evidence.ci95)}; concentration ${report.event_magnitude_evidence.event_concentration}; gate ${report.event_magnitude_evidence.gate_pass}. This is not directional alpha.`,
    '',
    '## Decision and boundary',
    '',
    `**${report.decision}**`,
    '',
    'Close the X8, signal sparsification, basic derivative augmentation, and current cross-sectional directional lines. Keep V1/alert-platform work scoped to product quality, alert UX, observability, data integrity, and performance monitoring.',
    '',
    '```text',
    ...Object.entries(report.safety_flags).map(([key, value]) => `${key}=${value}`),
    'holdout_outcomes_opened=false',
    'new_candidates_generated=false',
    'production_route_changes=false',
    '```',
    '',
    'No deployment. No merge. No M2. Wait for independent acceptance.',
    '',
  ];
  return lines.join('\n');
}

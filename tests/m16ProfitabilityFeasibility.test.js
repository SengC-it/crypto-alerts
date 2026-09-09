import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  M16_ACCEPTED_REPORTS,
  M16_DECISIONS,
  M16_INVALIDATED_REPORTS,
  M16_SAFETY_FLAGS,
  assertAcceptedArtifactPaths,
  assertM16Boundary,
  assertSingleProjectDecision,
  breakEvenRoundTripCost,
  buildM16Report,
  classifyCostFeasibility,
  deriveM16DecisionInputs,
  resolveM16Decision,
} from '../src/v2/m16ProfitabilityFeasibility.js';

function minimalReports() {
  return {
    M1: { benchmark: { data_source: 'archive', date_range: {}, symbols: [] }, metrics: { v2: {} }, promotion: {}, calibration: {}, candidate_count: 0 },
    M1_1: { data_source: 'archive', date_range: {}, symbols: [], primary_candidate: { metrics: {} }, stability: {}, calibration: {}, promotion: {}, decision: 'NO_ROBUST_EDGE_FOUND' },
    M1_2: { data_source: 'archive', date_range: {}, symbols: [], baseline_summary: {}, decision: 'NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN' },
    M1_3: { data_source: 'archive', date_range: {}, symbols: [], best_candidate: { metrics: {} }, decision: 'NO_ROBUST_CROSS_SECTIONAL_ALPHA' },
    M1_4: { data_source: 'archive', date_range: {}, symbols: [], review_lanes: [], primary_lane: 'R3', decision: 'DIRECTIONAL_RESEARCH_CONTINUE', event_alert_utility: {} },
    M1_5: { data_source: 'archive', validation: {}, configured_symbols: [], policies: {}, calibration: {}, gates: {}, decision: 'SPARSIFICATION_NOT_CONFIRMED', discovery_retention: { frozen_m14_reference: {}, fresh_d1: {}, fresh_delta_vs_m14: {} }, causality_gap: {} },
  };
}

function completeReports(overrides = {}) {
  const reports = minimalReports();
  reports.M1.promotion = { recommendation: 'REJECT' };
  reports.M1_1.promotion = { recommendation: 'REJECT' };
  reports.M1_2.baseline_summary = { absolute_promotion: { pass: false }, calibration: 'CALIBRATION_FAIL' };
  reports.M1_3.best_candidate = {
    metrics: { score_calibration: { status: 'CALIBRATION_FAIL' } },
    incremental_gate: { pass: false },
    absolute_gate: { pass: false },
  };
  reports.M1_4.event_alert_utility = {
    pass: false,
    delta_8h_absolute_return: 0.2,
    delta_8h_ci95: [0.1, 0.3],
    max_symbol_event_concentration: 0.6,
  };
  reports.M1_4.density_feasibility = {
    TOP1_PER_4H_EVENT_PER_DIRECTION: { DENSITY_ROBUST_GROSS_EDGE: true },
  };
  reports.M1_5.report_version = 'm1.6-causal-sparsification-validation-0.1.1';
  reports.M1_5.gates = {
    c1_confirmation: { pass: false },
    absolute_promotion: { pass: false },
  };
  reports.M1_5.calibration = { status: 'CALIBRATION_FAIL' };
  return { ...reports, ...overrides };
}

function artifactHashes() {
  return Object.fromEntries(Object.values(M16_ACCEPTED_REPORTS).map(path => [path, `sha-${path}`]));
}

test('M1.6 admits exactly accepted final artifacts and excludes invalidated M1.5 0.1.0', () => {
  assert.equal(assertAcceptedArtifactPaths(Object.values(M16_ACCEPTED_REPORTS)), true);
  assert.equal(Object.values(M16_ACCEPTED_REPORTS).some(path => M16_INVALIDATED_REPORTS.includes(path)), false);
  assert.throws(() => assertAcceptedArtifactPaths([...Object.values(M16_ACCEPTED_REPORTS), M16_INVALIDATED_REPORTS[0]]));
});

test('M1.6 boundary never opens holdouts, generates candidates, or changes production routes', () => {
  assert.equal(assertM16Boundary({}), true);
  for (const key of ['openedHoldoutOutcomes', 'generatedCandidates', 'productionRouteChanges', 'v2ProductionEnabled', 'autoTrading', 'm2Started']) {
    assert.throws(() => assertM16Boundary({ [key]: true }));
  }
  const report = buildM16Report({ reports: minimalReports(), reportFileHashes: {}, sourceSha: 'test' });
  assert.equal(report.holdout_outcomes_opened, false);
  assert.equal(report.new_candidates_generated, false);
  assert.equal(report.production_route_changes, false);
});

test('post-hoc M1.5 direction evidence cannot select BUY-only', () => {
  const report = buildM16Report({ reports: minimalReports(), reportFileHashes: {}, sourceSha: 'test' });
  assert.equal(report.directional_feasibility.directional_alpha_supported, false);
  assert.equal(report.directional_feasibility.directional_asymmetry_classification, 'POST_HOC_ONLY');
  assert.equal(report.directional_feasibility.buy_only_selection_allowed, false);
});

test('event magnitude evidence is explicitly non-directional', () => {
  const report = buildM16Report({ reports: minimalReports(), reportFileHashes: {}, sourceSha: 'test' });
  assert.equal(report.event_magnitude_evidence.directional_alpha, false);
  assert.equal(report.event_magnitude_evidence.source_stage, 'M1.4');
});

test('decision logic returns exactly one project decision', () => {
  const decision = resolveM16Decision({ evidenceSufficient: true });
  assert.equal(decision, 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM');
  assert.equal(resolveM16Decision(), 'INSUFFICIENT_PROJECT_EVIDENCE');
  assert.equal(assertSingleProjectDecision(decision).length, 1);
  assert.equal(new Set(assertSingleProjectDecision(decision)).size, 1);
  assert.deepEqual(M16_DECISIONS.includes(decision), true);
});

test('Decision A is bounded to at most one future information domain', () => {
  assert.equal(resolveM16Decision({ evidenceSufficient: true, directionalResearchJustified: true }), 'CONTINUE_DIRECTIONAL_ALPHA_WITH_NEW_INFORMATION_DOMAIN');
  const report = buildM16Report({ reports: minimalReports(), reportFileHashes: {}, sourceSha: 'test' });
  assert.equal(report.future_recommendation.new_information_domain, null);
  assert.equal(report.future_recommendation.implementation_authorized, false);
});

test('derived decision inputs fail closed when an accepted report or critical M1.5 field is missing', () => {
  const missingStage = completeReports();
  delete missingStage.M1_4;
  assert.equal(deriveM16DecisionInputs(missingStage, artifactHashes()).evidence_sufficient, false);

  const missingConfirmation = completeReports();
  delete missingConfirmation.M1_5.gates.c1_confirmation;
  const inputs = deriveM16DecisionInputs(missingConfirmation, artifactHashes());
  assert.equal(inputs.evidence_sufficient, false);
  assert.equal(inputs.fresh_causal_confirmation_pass, false);
});

test('accepted-equivalent evidence derives STOP rather than receiving a hardcoded decision', () => {
  const inputs = deriveM16DecisionInputs(completeReports(), artifactHashes());
  assert.equal(inputs.evidence_sufficient, true);
  assert.equal(inputs.accepted_stage_count, 6);
  assert.equal(inputs.directional_research_justified, false);
  assert.equal(inputs.event_alert_product_value_supported, false);
  assert.equal(resolveM16Decision(inputs), 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM');
});

test('event-alert gate PASS derives a non-directional pivot when directional research is false', () => {
  const reports = completeReports({
    M1_4: {
      ...completeReports().M1_4,
      event_alert_utility: {
        pass: true,
        delta_8h_absolute_return: 0.2,
        delta_8h_ci95: [0.1, 0.3],
        max_symbol_event_concentration: 0.2,
      },
    },
  });
  const inputs = deriveM16DecisionInputs(reports, artifactHashes());
  assert.equal(inputs.directional_research_justified, false);
  assert.equal(inputs.event_alert_product_value_supported, true);
  assert.equal(resolveM16Decision(inputs), 'PIVOT_TO_NON_DIRECTIONAL_MARKET_EVENT_RESEARCH');
});

test('synthetic robust fresh directional evidence changes the derived decision', () => {
  const reports = completeReports({
    M1: { ...completeReports().M1, promotion: { recommendation: 'PROMOTE' } },
    M1_5: {
      ...completeReports().M1_5,
      gates: { c1_confirmation: { pass: true }, absolute_promotion: { pass: true } },
    },
  });
  const inputs = deriveM16DecisionInputs(reports, artifactHashes());
  assert.equal(inputs.accepted_directional_promotion_found, true);
  assert.equal(inputs.fresh_causal_confirmation_pass, true);
  assert.equal(inputs.directional_research_justified, true);
  assert.equal(resolveM16Decision(inputs), 'CONTINUE_DIRECTIONAL_ALPHA_WITH_NEW_INFORMATION_DOMAIN');
});

test('M1.4 density discovery alone cannot become fresh causal confirmation', () => {
  const inputs = deriveM16DecisionInputs(completeReports(), artifactHashes());
  assert.equal(inputs.retrospective_density_only, true);
  assert.equal(inputs.m14_retrospective_density_confirmatory, false);
  assert.equal(inputs.fresh_causal_confirmation_pass, false);
  assert.equal(inputs.directional_research_justified, false);
});

test('positive enrichment with a failed event-alert gate cannot produce a pivot', () => {
  const reports = completeReports({
    M1_4: {
      ...completeReports().M1_4,
      event_alert_utility: {
        pass: false,
        delta_8h_absolute_return: 0.25,
        delta_8h_ci95: [0.2, 0.3],
        max_symbol_event_concentration: 0.50727651,
      },
    },
  });
  const inputs = deriveM16DecisionInputs(reports, artifactHashes());
  assert.equal(inputs.event_alert_product_value_supported, false);
  assert.equal(resolveM16Decision(inputs), 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM');
});

test('decision evidence hash ignores irrelevant report formatting and reproduces the final decision', () => {
  const first = completeReports();
  const second = completeReports();
  second.M1_4.presentation_note = 'irrelevant formatting only';
  const firstInputs = deriveM16DecisionInputs(first, artifactHashes());
  const secondInputs = deriveM16DecisionInputs(second, artifactHashes());
  assert.equal(firstInputs.decision_evidence_hash, secondInputs.decision_evidence_hash);
  assert.equal(resolveM16Decision(firstInputs), resolveM16Decision(secondInputs));
});

test('buildM16Report does not pass hardcoded final booleans and does not read holdout arrays', () => {
  const source = fs.readFileSync(new URL('../src/v2/m16ProfitabilityFeasibility.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /resolveM16Decision\(\{\s*directionalAlphaSupported:\s*false/);
  assert.doesNotMatch(source, /(?:final_holdout_outcomes|v2_records|oos_records)/);
});

test('fixed 0.14% cost is diagnostic and break-even equals gross expectancy', () => {
  assert.equal(breakEvenRoundTripCost(0.0358241), 0.0358241);
  assert.equal(breakEvenRoundTripCost(-0.1), 'NO_POSITIVE_GROSS_EDGE');
  assert.equal(classifyCostFeasibility({ grossExpectancyPercent: 0.0358241, netExpectancyPercent: -0.1041759 }), 'EDGE_EXISTS_ONLY_BEFORE_COST');
  assert.equal(classifyCostFeasibility({ grossExpectancyPercent: -0.01, netExpectancyPercent: -0.15 }), 'NO_MEANINGFUL_GROSS_EDGE');
});

test('M1.6 safety flags preserve research-only operation', () => {
  assert.equal(M16_SAFETY_FLAGS.SIGNAL_ONLY, true);
  assert.equal(M16_SAFETY_FLAGS.V1_UNCHANGED, true);
  assert.equal(M16_SAFETY_FLAGS.V2_PRODUCTION_ENABLED, false);
  assert.equal(M16_SAFETY_FLAGS.AUTO_TRADING, false);
  assert.equal(M16_SAFETY_FLAGS.PRIVATE_TRADING_API, false);
  assert.equal(M16_SAFETY_FLAGS.M2_STARTED, false);
});

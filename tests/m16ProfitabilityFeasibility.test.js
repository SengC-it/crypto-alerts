import assert from 'node:assert/strict';
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
  assert.equal(report.directional_feasibility.classification, 'POST_HOC_ONLY');
  assert.equal(report.directional_feasibility.buy_only_selection_allowed, false);
});

test('event magnitude evidence is explicitly non-directional', () => {
  const report = buildM16Report({ reports: minimalReports(), reportFileHashes: {}, sourceSha: 'test' });
  assert.equal(report.event_magnitude_evidence.directional_alpha, false);
  assert.equal(report.event_magnitude_evidence.source_stage, 'M1.4');
});

test('decision logic returns exactly one project decision', () => {
  const decision = resolveM16Decision();
  assert.equal(decision, 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM');
  assert.equal(assertSingleProjectDecision(decision).length, 1);
  assert.equal(new Set(assertSingleProjectDecision(decision)).size, 1);
  assert.deepEqual(M16_DECISIONS.includes(decision), true);
});

test('Decision A is bounded to at most one future information domain', () => {
  assert.equal(resolveM16Decision({ directionalAlphaSupported: true }), 'CONTINUE_DIRECTIONAL_ALPHA_WITH_NEW_INFORMATION_DOMAIN');
  const report = buildM16Report({ reports: minimalReports(), reportFileHashes: {}, sourceSha: 'test' });
  assert.equal(report.future_recommendation.new_information_domain, null);
  assert.equal(report.future_recommendation.implementation_authorized, false);
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

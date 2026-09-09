import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M14_COSTS_PERCENT,
  M14_DENSITY_POLICIES,
  M14_EVENT_ALERT_BOOTSTRAP_SEED,
  M14_SAFETY_FLAGS,
  assertReviewCalendarParity,
  bootstrapEventValues,
  buildCanonicalReviewPlan,
  buildDensityViews,
  buildEventAlertObservations,
  buildUniverseSlices,
  classifyDensityFeasibility,
  classifyDirectionalEdge,
  compactEventAlertEvents,
  reviewConfigHash,
  resolveFeasibilityDecision,
  spearmanIc,
  summarizeEventAlertUtility,
  summarizeReviewRecords,
} from '../src/v2/m14Review.js';

const HOUR = 60 * 60 * 1000;
const START = Date.parse('2026-01-01T00:59:59.999Z');

function record(index, overrides = {}) {
  const timestamp = START + index * HOUR;
  return {
    timestamp,
    symbol: index % 2 ? 'ETHUSDT' : 'BTCUSDT',
    direction: index % 2 ? 'SELL' : 'BUY',
    independent_market_event_id: `event-${Math.floor(index / 4)}`,
    review_window_index: index < 8 ? 0 : 1,
    raw_score: 50 + index,
    edge_score: 50 + index,
    forward_returns: { '1h': 0.02, '4h': 0.04, '8h': 0.12, '12h': 0.1, '24h': 0.08, '48h': 0.05 },
    net_forward_returns: { '1h': -0.12, '4h': -0.1, '8h': -0.02, '12h': -0.04, '24h': -0.06, '48h': -0.09 },
    ...overrides,
  };
}

function calendar() {
  return buildCanonicalReviewPlan({
    sourceTimelineStart: START,
    sourceTimelineEnd: START + 20 * HOUR,
    finalHoldoutStart: START + 18 * HOUR,
    windows: [
      { index: 0, train_start: START, train_end: START + 5 * HOUR, purge_start: START + 6 * HOUR, purge_end: START + 7 * HOUR, test_start: START + 8 * HOUR, test_end: START + 11 * HOUR, embargo_start: START + 12 * HOUR, embargo_end: START + 13 * HOUR },
      { index: 1, train_start: START + 2 * HOUR, train_end: START + 9 * HOUR, purge_start: START + 10 * HOUR, purge_end: START + 11 * HOUR, test_start: START + 12 * HOUR, test_end: START + 15 * HOUR, embargo_start: START + 16 * HOUR, embargo_end: START + 17 * HOUR },
    ],
  });
}

test('M1.4 canonical review plan is independent of outcomes and sample density', () => {
  const first = calendar();
  const second = calendar();
  second.windows = second.windows.map(window => ({ ...window, outcome: 999999 }));
  assert.equal(first.canonical_review_plan_hash, calendar().canonical_review_plan_hash);
  assert.equal(first.canonical_review_plan_hash, second.canonical_review_plan_hash);
  const parity = assertReviewCalendarParity([
    { lane_id: 'sparse', review_plan: first },
    { lane_id: 'dense', review_plan: first },
  ]);
  assert.equal(parity.same_train_windows, true);
  assert.equal(parity.same_oos_windows, true);
  assert.equal(parity.same_purge, true);
  assert.equal(parity.same_embargo, true);
  assert.equal(parity.same_final_holdout_boundary, true);
});

test('M1.4 density views are exactly the three predeclared diagnostics', () => {
  const views = buildDensityViews(Array.from({ length: 8 }, (_, index) => record(index)));
  assert.deepEqual(Object.keys(views).sort(), [...M14_DENSITY_POLICIES].sort());
  assert.equal(views.TOP1_PER_4H_EVENT_PER_DIRECTION.length, 4);
  assert.equal(views.TOP1_PER_4H_EVENT_TOTAL.length, 2);
});

test('M1.4 cost matrix inputs do not enter review configuration or selection policy', () => {
  const first = reviewConfigHash({ baseMainSha: 'base', symbols: ['BTCUSDT'], lanes: [{ lane_id: 'R3' }], calendarHash: 'calendar', costs: M14_COSTS_PERCENT });
  const second = reviewConfigHash({ baseMainSha: 'base', symbols: ['BTCUSDT'], lanes: [{ lane_id: 'R3' }], calendarHash: 'calendar', costs: [0.14] });
  assert.notEqual(first, second);
  assert.deepEqual(M14_COSTS_PERCENT, [0, 0.05, 0.1, 0.14, 0.2, 0.3]);
});

test('M1.4 event alert comparator uses same timestamp support and independent 4h bootstrap', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'];
  const candlesBySymbol = Object.fromEntries(symbols.map(symbol => [symbol, Array.from({ length: 10 }, (_, index) => {
    const multiplier = symbol === 'BTCUSDT' ? 1 + index * 0.01 : 1 + index * 0.001;
    return { symbol, close_time: START + index * HOUR, close: 100 * multiplier, is_closed: true };
  })]));
  const snapshots = [{
    timestamp: START,
    valid_symbols: symbols,
    candles: Object.fromEntries(symbols.map(symbol => [symbol, { symbol, close_time: START, close: 100 }])),
  }];
  const events = buildEventAlertObservations([record(0, { symbol: 'BTCUSDT', independent_market_event_id: 'event-0' })], { candlesBySymbol, snapshots, horizonHours: 8, windows: [{ index: 0, test_start: START, test_end: START + HOUR }] });
  assert.equal(events.length, 1);
  assert.ok(events[0].delta_abs_return > 0);
  assert.equal(compactEventAlertEvents(events).count, 1);
  const summary = summarizeEventAlertUtility(events, { windows: [{ index: 0 }], repetitions: 50, seed: M14_EVENT_ALERT_BOOTSTRAP_SEED });
  assert.equal(summary.bootstrap.unit, 'independent_market_event_id');
  assert.equal(summary.bootstrap.seed, 20260908);
  assert.equal(summary.gate_pass, false);
});

test('M1.4 event bootstrap is deterministic and does not resample rows', () => {
  const values = [1, -0.5, 0.2];
  const first = bootstrapEventValues(values, { repetitions: 100, seed: 20260908 });
  const second = bootstrapEventValues(values, { repetitions: 100, seed: 20260908 });
  assert.deepEqual(first, second);
  assert.equal(first.unit_count, 3);
});

test('M1.4 directional diagnostics do not disable either direction', () => {
  const rows = Array.from({ length: 16 }, (_, index) => record(index));
  const ic = spearmanIc(rows, { horizonHours: 8, windows: calendar().windows });
  assert.equal(ic.horizon_hours, 8);
  assert.deepEqual(Object.keys(buildUniverseSlices(rows, { tier1: ['BTCUSDT'], tier2: ['ETHUSDT'], tier3: ['SOLUSDT'] })).sort(), ['All18', 'Tier1', 'Tier1+Tier2', 'Tier2', 'Tier3'].sort());
  const result = classifyDirectionalEdge(rows, { horizonHours: 8, windows: calendar().windows, calibration: 'CALIBRATION_FAIL', repetitions: 50 });
  assert.ok(['NO_GROSS_DIRECTIONAL_EDGE', 'GROSS_EDGE_BUT_COST_CONSTRAINED', 'NET_DIRECTIONAL_EDGE'].includes(result.classification));
});

test('M1.4 separates gross and net positive-window stability', () => {
  const rows = Array.from({ length: 16 }, (_, index) => record(index, {
    forward_returns: { '8h': index < 8 ? 0.1 : 0.2 },
  }));
  const summary = summarizeReviewRecords(rows, { horizonHours: 8, costPercent: 0.14, windows: calendar().windows });
  assert.equal(summary.gross_positive_windows, 2);
  assert.equal(summary.gross_positive_window_ratio, 1);
  assert.equal(summary.net_positive_windows, 1);
  assert.equal(summary.net_positive_window_ratio, 0.5);
  assert.equal(summary.positive_windows, summary.net_positive_windows);
});

test('M1.4 classifies a gross edge constrained by fixed net cost', () => {
  const rows = Array.from({ length: 16 }, (_, index) => record(index, {
    forward_returns: { '8h': index < 8 ? 0.1 : 0.12 },
  }));
  const result = classifyDirectionalEdge(rows, {
    horizonHours: 8,
    windows: calendar().windows,
    calibration: 'CALIBRATION_FAIL',
    repetitions: 100,
  });
  assert.equal(result.classification, 'GROSS_EDGE_BUT_COST_CONSTRAINED');
  assert.equal(result.gross_summary.gross_positive_window_ratio, 1);
  assert.equal(result.net_summary.net_positive_window_ratio, 0);
  assert.equal(result.gross_bootstrap.ci95[0] > 0, true);
  assert.equal(result.net_bootstrap.mean < 0, true);
});

test('M1.4 preserves frozen 4h primary semantics while keeping 8h diagnostic', () => {
  const rows = Array.from({ length: 8 }, (_, index) => record(index, {
    forward_returns: { '4h': -0.1, '8h': 0.2 },
  }));
  const primary = summarizeReviewRecords(rows, { horizonHours: 4, costPercent: 0.14, windows: calendar().windows });
  const diagnostic = summarizeReviewRecords(rows, { horizonHours: 8, costPercent: 0.14, windows: calendar().windows });
  assert.equal(primary.horizon_hours, 4);
  assert.equal(diagnostic.horizon_hours, 8);
  assert.equal(primary.net_expectancy_percent < diagnostic.net_expectancy_percent, true);
});

test('M1.4 density feasibility uses exactly three fixed 8h diagnostic views', () => {
  const rows = Array.from({ length: 8 }, (_, index) => record(index, {
    forward_returns: { '8h': 0.2 },
  }));
  const views = buildDensityViews(rows);
  assert.deepEqual(Object.keys(views).sort(), [...M14_DENSITY_POLICIES].sort());
  const result = classifyDensityFeasibility(views.TOP1_PER_4H_EVENT_TOTAL, {
    horizonHours: 8,
    windows: calendar().windows,
    repetitions: 100,
  });
  assert.equal(result.horizon_hours, 8);
  assert.equal(result.independent_events < 100, true);
  assert.equal(result.DENSITY_ROBUST_GROSS_EDGE, false);
  assert.equal(result.gross_bootstrap.unit_count, result.independent_events);
  assert.equal(result.shadow_candidate, undefined);
  assert.equal(result.production_approval, undefined);
});

test('M1.4 density robust-gross gate enforces event, CI and concentration limits', () => {
  const symbols = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'AVAXUSDT', 'LINKUSDT'];
  const rows = Array.from({ length: 120 }, (_, index) => record(index, {
    symbol: symbols[index % symbols.length],
    independent_market_event_id: `density-${index}`,
    review_window_index: index < 60 ? 0 : 1,
    forward_returns: { '8h': 0.2 },
  }));
  const passing = classifyDensityFeasibility(rows, { horizonHours: 8, windows: calendar().windows, repetitions: 100 });
  assert.equal(passing.DENSITY_ROBUST_GROSS_EDGE, true);
  assert.equal(passing.independent_events, 120);
  const tooConcentrated = classifyDensityFeasibility(rows.map(row => ({ ...row, symbol: 'BTCUSDT' })), { horizonHours: 8, windows: calendar().windows, repetitions: 100 });
  assert.equal(tooConcentrated.unique_event_symbol_concentration, 1);
  assert.equal(tooConcentrated.DENSITY_ROBUST_GROSS_EDGE, false);
  const noCi = classifyDensityFeasibility(rows.map(row => ({ ...row, forward_returns: { '8h': row.symbol === 'BTCUSDT' ? 0.2 : -0.2 } })), { horizonHours: 8, windows: calendar().windows, repetitions: 100 });
  assert.equal(noCi.gross_bootstrap.ci95[0] < 0, true);
  assert.equal(noCi.DENSITY_ROBUST_GROSS_EDGE, false);
});

test('M1.4 unique event-symbol concentration counts a symbol once per event', () => {
  const rows = [
    record(0, { symbol: 'BTCUSDT', independent_market_event_id: 'same-event', forward_returns: { '8h': 0.2 } }),
    record(1, { symbol: 'BTCUSDT', independent_market_event_id: 'same-event', forward_returns: { '8h': 0.2 } }),
    record(2, { symbol: 'ETHUSDT', independent_market_event_id: 'same-event', forward_returns: { '8h': 0.2 } }),
    record(4, { symbol: 'BTCUSDT', independent_market_event_id: 'other-event', forward_returns: { '8h': 0.2 } }),
  ];
  const summary = summarizeReviewRecords(rows, { horizonHours: 8, windows: calendar().windows });
  assert.equal(summary.independent_events, 2);
  assert.equal(summary.unique_event_symbol_concentration, 1);
  assert.equal(summary.max_symbol_event_concentration <= 1, true);
  assert.equal(summary.max_symbol_record_concentration, 0.75);
});

test('M1.4 density feasibility can continue research without production or M2 enablement', () => {
  assert.equal(resolveFeasibilityDecision({ densityRobustGrossEdge: true }), 'DIRECTIONAL_RESEARCH_CONTINUE');
  assert.equal(resolveFeasibilityDecision({ eventAlertUtilityPass: true }), 'PIVOT_TO_MARKET_EVENT_ALERTS');
  assert.equal(resolveFeasibilityDecision({}), 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM');
  assert.equal(resolveFeasibilityDecision({ evidenceSufficient: false, densityRobustGrossEdge: true }), 'INSUFFICIENT_FEASIBILITY_EVIDENCE');
  assert.equal(M14_SAFETY_FLAGS.SIGNAL_ONLY, true);
  assert.equal(M14_SAFETY_FLAGS.V1_UNCHANGED, true);
  assert.equal(M14_SAFETY_FLAGS.V2_PRODUCTION_ENABLED, false);
  assert.equal(M14_SAFETY_FLAGS.AUTO_TRADING, false);
  assert.equal(M14_SAFETY_FLAGS.PRIVATE_TRADING_API, false);
  assert.equal(M14_SAFETY_FLAGS.M2_STARTED, false);
});

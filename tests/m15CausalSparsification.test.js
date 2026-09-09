import assert from 'node:assert/strict';
import test from 'node:test';
import {
  M15_BOOTSTRAP_SEED,
  M15_COST_PERCENT,
  M15_MIN_BUCKET_CLOSE_BREADTH,
  M15_MOVING_BLOCK_LENGTH,
  M15_POLICY_IDS,
  M15_POLICY_ORDER,
  M15_SAFETY_FLAGS,
  M15_VALIDATION_WINDOW_COUNT,
  buildCausalViews,
  buildCausalityGap,
  buildDiscoveryRetention,
  buildM15ConfigHash,
  buildRetrospectiveViews,
  buildValidationWindows,
  evaluateAbsolutePromotion,
  evaluateC1Confirmation,
  evaluateD1Replication,
  movingBlockBootstrap,
  resolveM15Decision,
  standardEventBootstrap,
} from '../src/v2/m15CausalSparsification.js';
import { buildDensityViews } from '../src/v2/m14Review.js';

const HOUR = 60 * 60 * 1000;
const BASE = Date.parse('2026-01-01T00:00:00.000Z');
const SYMBOLS = [
  'ADAUSDT', 'AVAXUSDT', 'BNBUSDT', 'BTCUSDT', 'DOGEUSDT', 'DOTUSDT',
  'ETHUSDT', 'LINKUSDT', 'LTCUSDT', 'SOLUSDT', 'TRXUSDT', 'XRPUSDT',
];

function row(eventIndex, symbolIndex, timestamp, overrides = {}) {
  const eventStart = BASE + eventIndex * 4 * HOUR;
  return {
    timestamp,
    symbol: SYMBOLS[symbolIndex % SYMBOLS.length],
    direction: symbolIndex % 2 ? 'SELL' : 'BUY',
    independent_market_event_id: 'm13-4h:' + eventStart,
    valid_symbol_count: M15_MIN_BUCKET_CLOSE_BREADTH,
    edge_score: 10 + symbolIndex,
    raw_score: 10 + symbolIndex,
    forward_returns: { '8h': 0.3 },
    net_forward_returns: { '8h': 0.16 },
    ...overrides,
  };
}

function eventRows(eventIndex, outcome = 0.3) {
  const eventStart = BASE + eventIndex * 4 * HOUR;
  const close = eventStart + 4 * HOUR - 1;
  return SYMBOLS.map((symbol, index) => row(eventIndex, index, close, {
    symbol,
    edge_score: index === 0 ? 99 : 20 + index,
    forward_returns: { '8h': outcome },
    net_forward_returns: { '8h': outcome - M15_COST_PERCENT },
  }));
}

test('M1.5 declares exactly the four frozen policy views', () => {
  assert.deepEqual([...M15_POLICY_ORDER], [
    M15_POLICY_IDS.D1,
    M15_POLICY_IDS.D2,
    M15_POLICY_IDS.C1,
    M15_POLICY_IDS.C2,
  ]);
  assert.equal(new Set(M15_POLICY_ORDER).size, 4);
});

test('causal views use only the canonical bucket-close snapshot and ignore future scores', () => {
  const rows = [
    ...eventRows(0),
    row(0, 0, BASE + 5 * HOUR, {
      symbol: 'BTCUSDT',
      direction: 'BUY',
      edge_score: 999999,
      forward_returns: { '8h': -999 },
    }),
  ];
  const views = buildCausalViews(rows);
  assert.equal(views.support.eligible_events.length, 1);
  assert.equal(views[M15_POLICY_IDS.C1].length, 2);
  assert.equal(views[M15_POLICY_IDS.C2].length, 1);
  assert.equal(Math.max(...views[M15_POLICY_IDS.C1].map(item => item.timestamp)), BASE + 4 * HOUR - 1);
  assert.equal(views[M15_POLICY_IDS.C1].some(item => item.edge_score === 999999), false);
  assert.equal(views[M15_POLICY_IDS.C1].every(item => item.causal_bucket_close === true), true);
});

test('causal selection is invariant to outcome and future-label poisoning', () => {
  const rows = eventRows(0);
  const poisoned = rows.map(record => ({
    ...record,
    forward_returns: { '8h': -12345 },
    net_forward_returns: { '8h': -12345 },
  }));
  const first = buildCausalViews(rows);
  const second = buildCausalViews(poisoned);
  assert.deepEqual(
    second[M15_POLICY_IDS.C1].map(record => [record.symbol, record.direction, record.edge_score]),
    first[M15_POLICY_IDS.C1].map(record => [record.symbol, record.direction, record.edge_score]),
  );
  assert.deepEqual(
    second[M15_POLICY_IDS.C2].map(record => [record.symbol, record.direction, record.edge_score]),
    first[M15_POLICY_IDS.C2].map(record => [record.symbol, record.direction, record.edge_score]),
  );
});

test('insufficient bucket-close breadth fails closed', () => {
  const rows = eventRows(0).slice(0, M15_MIN_BUCKET_CLOSE_BREADTH - 1);
  const views = buildCausalViews(rows);
  assert.equal(views.support.eligible_events.length, 0);
  assert.equal(views.support.rejected_events[0].reason, 'INSUFFICIENT_BUCKET_CLOSE_BREADTH');
});

test('D1 and D2 reuse the exact M1.4 density semantics', () => {
  const rows = [...eventRows(0), ...eventRows(1)];
  const expected = buildDensityViews(rows);
  const actual = buildRetrospectiveViews(rows);
  assert.deepEqual(actual[M15_POLICY_IDS.D1], expected.TOP1_PER_4H_EVENT_PER_DIRECTION);
  assert.deepEqual(actual[M15_POLICY_IDS.D2], expected.TOP1_PER_4H_EVENT_TOTAL);
  assert.equal(actual.support.deployable, false);
});

test('validation windows are exactly eight contiguous outcome-independent windows', () => {
  const rows = Array.from({ length: 16 }, (_, eventIndex) => eventRows(eventIndex)[0]);
  const plan = buildValidationWindows(rows);
  assert.equal(plan.window_count, M15_VALIDATION_WINDOW_COUNT);
  assert.equal(plan.windows.length, 8);
  assert.deepEqual(plan.windows.map(window => window.event_count), Array(8).fill(2));
  assert.equal(plan.windows[0].event_close_start_timestamp < plan.windows[1].event_close_start_timestamp, true);
  const poisoned = rows.map(record => ({ ...record, forward_returns: { '8h': -999 } }));
  assert.equal(buildValidationWindows(poisoned).validation_plan_hash, plan.validation_plan_hash);
});

test('standard and moving-block event bootstrap are deterministic and event-level', () => {
  const rows = Array.from({ length: 16 }, (_, eventIndex) => eventRows(eventIndex, 0.2 + eventIndex / 1000)[0]);
  const standard = standardEventBootstrap(rows, { repetitions: 100, seed: M15_BOOTSTRAP_SEED });
  const standardAgain = standardEventBootstrap(rows, { repetitions: 100, seed: M15_BOOTSTRAP_SEED });
  const moving = movingBlockBootstrap(rows, {
    repetitions: 100,
    seed: M15_BOOTSTRAP_SEED,
    blockLength: M15_MOVING_BLOCK_LENGTH,
  });
  assert.deepEqual(standard, standardAgain);
  assert.equal(standard.gross.unit, 'independent_market_event_id');
  assert.equal(standard.gross.unit_count, 16);
  assert.equal(moving.net.block_length_events, 3);
  assert.equal(moving.net.block_length_hours, 12);
  assert.equal(moving.net.unit_count, 16);
});

test('gates enforce the frozen D1, C1, and absolute promotion rules', () => {
  const policy = {
    independent_events: 120,
    gross_expectancy_percent: 0.4,
    net_expectancy_percent: 0.2,
    gross_pf: 1.4,
    net_pf: 1.3,
    gross_positive_window_ratio: 0.75,
    net_positive_window_ratio: 0.75,
    net_positive_windows: 6,
    total_windows: 8,
    symbol_breadth: 12,
    unique_event_symbol_concentration: 0.2,
    standard_bootstrap: {
      gross: { ci95: [0.01, 0.8], p_gt_zero: 0.99 },
      net: { ci95: [0.01, 0.4], p_gt_zero: 0.99 },
    },
    moving_block_bootstrap: {
      net: { ci95: [0.01, 0.3], p_gt_zero: 0.99 },
    },
  };
  assert.equal(evaluateD1Replication(policy).pass, true);
  assert.equal(evaluateC1Confirmation(policy).pass, true);
  assert.equal(evaluateAbsolutePromotion({ ...policy, confirmation_pass: true }, { status: 'PASS' }).pass, true);
  assert.equal(evaluateAbsolutePromotion({ ...policy, confirmation_pass: false }, { status: 'PASS' }).pass, false);
});

test('C2 is secondary-only and cannot change the primary decision', () => {
  assert.equal(resolveM15Decision({
    c1Confirmation: false,
    absolutePromotion: false,
    d1Replication: false,
  }), 'SPARSIFICATION_NOT_CONFIRMED');
  assert.equal(resolveM15Decision({
    c1Confirmation: false,
    absolutePromotion: false,
    d1Replication: true,
  }), 'RETROSPECTIVE_SPARSIFICATION_REPLICATED_ONLY');
  assert.equal(resolveM15Decision({
    c1Confirmation: true,
    absolutePromotion: false,
  }), 'CAUSAL_SPARSIFICATION_CONFIRMED_NOT_PROMOTABLE');
});

test('causality gap and discovery retention are diagnostics only', () => {
  const d1 = eventRows(0);
  const c1 = eventRows(0).slice(0, 2);
  const gap = buildCausalityGap(d1, c1);
  assert.equal(gap.diagnostic_only, true);
  assert.equal(gap.selected_symbol_direction_overlap_count, 2);
  const retention = buildDiscoveryRetention({
    gross_expectancy_percent: 0.4,
    net_expectancy_percent: 0.2,
    gross_pf: 1.5,
    net_pf: 1.3,
    gross_positive_windows: 7,
    net_positive_windows: 6,
    unique_event_symbol_concentration: 0.2,
  });
  assert.equal(retention.causal_policy_changed, true);
  assert.equal(retention.selection_policy_changed, false);
});

test('M1.5 config hash and safety flags freeze research-only scope', () => {
  const first = buildM15ConfigHash({ symbols: SYMBOLS, validationPlanHash: 'plan' });
  const second = buildM15ConfigHash({ symbols: [...SYMBOLS].reverse(), validationPlanHash: 'plan' });
  assert.equal(first, second);
  assert.equal(M15_SAFETY_FLAGS.V2_PRODUCTION_ENABLED, false);
  assert.equal(M15_SAFETY_FLAGS.AUTO_TRADING, false);
  assert.equal(M15_SAFETY_FLAGS.M2_STARTED, false);
});

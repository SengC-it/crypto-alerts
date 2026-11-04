import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateObservationRow, refreshObservationRows, summarizeObservationPerformance } from '../src/signal/observationPerformance.js';

const MINUTE = 60_000;
const iso = value => new Date(value).toISOString();
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} != ${expected}`);
function row(overrides = {}) {
  return { symbol: 'TESTUSDT', strategy: 'donchian_breakout', signal_direction: 'SELL', stop_loss: 105, target_price: 90,
    delivery_status: 'delivered', delivered_at: iso(4_000),
    raw_features: { observation: { version: 'ab-observation-v1', candidates: ['A', 'B'], reference_time: iso(1_000), reference_price: 100 } },
    ...overrides };
}
function candle(index, overrides = {}) {
  return { open_time: index * MINUTE, open: 100, high: 101, low: 99, close: 100, ...overrides };
}
function evaluate(source, candles, funding = [], now = (candles.at(-1)?.open_time ?? 0) + MINUTE) {
  return evaluateObservationRow(source, { now, candles, funding });
}
function withState(source, evaluation) {
  return { ...source, raw_features: { ...source.raw_features,
    observation: { ...source.raw_features.observation, evaluation } } };
}

describe('Online observation reference outcomes', () => {
  it('measures A after delivery when its optional live ticker quote was unavailable', () => {
    const source = row();
    source.raw_features.observation.reference_time = null;
    source.raw_features.observation.reference_price = null;
    const state = evaluate(source, [candle(1, { low: 89 })]);
    assert.equal(state.status, 'closed');
    assert.equal(state.entry_time, iso(MINUTE));
    near(state.net_pnl_usdt, 9.86);
    const summary = summarizeObservationPerformance([withState(source, state)], { candidateId: 'A', now: 2 * MINUTE });
    assert.equal(summary.incomplete, false);
    assert.equal(summary.firstObservedAt, source.delivered_at);
  });

  it('leaves all rows available when a refresh budget or deadline is exhausted', async () => {
    const rows = [row({ id: 1 }), row({ id: 2 })];
    let calls = 0;
    const options = { now: 2 * MINUTE, fetchCandles: async () => { calls++; return [candle(1, { low: 89 })]; },
      fetchFunding: async () => [], saveEvaluation: async () => {} };
    const limited = await refreshObservationRows(rows, { ...options, maxRows: 1 });
    assert.equal(calls, 1);
    assert.equal(limited.length, 2);
    assert.equal(limited[1], rows[1]);
    const expired = await refreshObservationRows(rows, { ...options, deadline: 0 });
    assert.equal(calls, 1);
    assert.deepEqual(expired, rows);
  });

  it('starts after both the quote and actual email delivery, never at the old trigger price', () => {
    const source = row({ delivered_at: iso(MINUTE + 500) });
    const state = evaluate(source, [candle(1, { low: 80 }), candle(2, { open: 102, high: 103, low: 101, close: 102 })]);
    assert.equal(state.entry_time, iso(2 * MINUTE));
    assert.equal(state.entry_price, 102);
    assert.equal(state.status, 'open');
    assert.equal(state.net_pnl_usdt, null);
    near(state.unrealized_net_pnl_usdt, -0.14);
  });

  it('uses stop first if both barriers touch in one minute and deducts both costs once', () => {
    const state = evaluate(row(), [candle(1, { high: 106, low: 89 })]);
    assert.equal(state.status, 'closed');
    assert.equal(state.exit_reason, 'stop_loss');
    assert.equal(state.ambiguous, true);
    near(state.gross_pnl_usdt, -5);
    near(state.net_pnl_usdt, -5.14);
    near(state.transaction_cost_usdt, 0.14);
  });

  it('fills a stop gap at the available open, and scales actual funding by mark/entry', () => {
    const funding = [{ fundingTime: 2 * MINUTE + 4, fundingRate: '0.001', markPrice: '110' }];
    const state = evaluate(row(), [candle(1), candle(2, { open: 110, high: 112, low: 109, close: 111 })], funding);
    assert.equal(state.exit_reason, 'stop_loss_gap');
    assert.equal(state.exit_time, iso(2 * MINUTE));
    near(state.funding_pnl_usdt, 0.11);
    near(state.net_pnl_usdt, -10.03);
  });

  it('does not charge funding on the same minute as a new reference and does not mutate raw timestamps', () => {
    const funding = [{ fundingTime: MINUTE + 4, fundingRate: '0.001', markPrice: '100' }];
    const state = evaluate(row(), [candle(1)], funding);
    near(state.funding_pnl_usdt, 0);
    assert.equal(funding[0].fundingTime, MINUTE + 4);
  });

  it('advances only through the contiguous prefix and resumes without duplicate fees or funding', () => {
    const source = row();
    const first = evaluate(source, [candle(1), candle(3)], [], 4 * MINUTE);
    assert.equal(first.checked_until, iso(2 * MINUTE));
    assert.match(first.review_error, /Missing minute/);
    const funding = [{ fundingTime: 2 * MINUTE, fundingRate: 0.001, markPrice: 100 }];
    const second = evaluate(withState(source, first), [candle(2), candle(3, { low: 89, close: 90 })], funding, 4 * MINUTE);
    const together = evaluate(source, [candle(1), candle(2), candle(3, { low: 89, close: 90 })], funding, 4 * MINUTE);
    near(second.net_pnl_usdt, together.net_pnl_usdt);
    near(second.net_pnl_usdt, 9.96);
    assert.equal(second.review_error, null);
    near(second.transaction_cost_usdt, 0.14);
  });

  it('does not turn missing funding, null rates, malformed OHLC or impossible entry geometry into outcomes', () => {
    const source = row();
    const absent = evaluateObservationRow(source, { now: 2 * MINUTE, candles: [candle(1)] });
    assert.equal(absent.status, 'pending');
    assert.equal(absent.checked_until, null);
    assert.match(absent.review_error, /funding arrays/);
    const invalidRate = evaluate(source, [candle(1)], [{ fundingTime: MINUTE, fundingRate: null, markPrice: 100 }]);
    assert.equal(invalidRate.net_pnl_usdt, null);
    assert.match(invalidRate.review_error, /funding/);
    const invalidCandle = evaluate(source, [candle(1, { high: 99 })]);
    assert.match(invalidCandle.review_error, /Invalid OHLC/);
    const invalidEntry = evaluate(source, [candle(1, { open: 110, high: 111, low: 109, close: 110 })]);
    assert.equal(invalidEntry.status, 'invalid');
    assert.equal(invalidEntry.net_pnl_usdt, null);
  });

  it('uses the correct BUY funding sign and only closed minutes', () => {
    const source = row({ signal_direction: 'BUY', stop_loss: 95, target_price: 110 });
    const state = evaluate(source, [candle(1), candle(2, { high: 111, close: 110 }), candle(3, { high: 200 })],
      [{ fundingTime: 2 * MINUTE, fundingRate: 0.001, markPrice: 100 }], 3 * MINUTE + 20_000);
    near(state.net_pnl_usdt, 9.76);
    assert.equal(state.exit_time, iso(3 * MINUTE - 1));
  });

  it('bounds a refresh to 1,500 minutes and leaves failed fetches pending', async () => {
    const calls = [];
    const saved = [];
    const result = await refreshObservationRows([row()], { now: 2000 * MINUTE,
      fetchCandles: async (symbol, start, end) => { calls.push([symbol, start, end]); throw new Error('Data unavailable'); },
      fetchFunding: async () => [], saveEvaluation: async (_, evaluation) => saved.push(evaluation) });
    assert.equal(calls[0][2] - calls[0][1], 1500 * MINUTE);
    assert.equal(saved.length, 1);
    assert.match(saved[0].review_error, /Data unavailable/);
    assert.equal(result[0].raw_features.observation.evaluation.net_pnl_usdt, null);
  });

  it('persists a successful refresh and skips already terminal and undelivered rows', async () => {
    const source = row();
    const closed = withState(source, evaluate(source, [candle(1, { low: 89 })]));
    let saves = 0;
    const result = await refreshObservationRows([source, closed, row({ delivery_status: 'failed' })], {
      now: 2 * MINUTE, fetchCandles: async () => [candle(1, { low: 89 })], fetchFunding: async () => [],
      saveEvaluation: async () => { saves++; } });
    assert.equal(saves, 1);
    assert.equal(result[0].raw_features.observation.evaluation.status, 'closed');
    assert.equal(result[1], closed);
  });
});

describe('Observation cumulative summaries', () => {
  it('keeps completed profit available when another reference became non-actionable', () => {
    const source = row();
    const closed = withState(source, evaluate(source, [candle(1, { low: 89 })]));
    const invalid = withState(source, evaluate(source, [candle(1, { open: 110, high: 111, low: 109, close: 110 })]));
    const summary = summarizeObservationPerformance([closed, invalid], { candidateId: 'A', now: 2 * MINUTE });
    assert.equal(summary.closed, 1);
    assert.equal(summary.invalid, 1);
    assert.equal(summary.incomplete, false);
    near(summary.netPnlUSDT, 9.86);
    assert.match(invalid.raw_features.observation.evaluation.invalid_reason, /outside/);
  });

  it('summarizes new-version OLD references without mixing legacy or other strategy records', () => {
    const source = row();
    const closed = withState(source, evaluate(source, [candle(1, { low: 89 })]));
    const trackedOld = { ...closed, raw_features: { observation: { ...closed.raw_features.observation, candidates: ['OLD'] } } };
    const trackedBoth = { ...closed, raw_features: { observation: { ...closed.raw_features.observation, candidates: ['OLD', 'A', 'B'] } } };
    const legacy = { ...trackedOld, raw_features: {} };
    const other = { ...trackedOld, strategy: 'rsi_reversal' };
    const summary = summarizeObservationPerformance([trackedOld, trackedBoth, legacy, other], {
      candidateId: 'OLD', strategy: 'donchian_breakout', now: 2 * MINUTE });
    assert.equal(summary.total, 2);
    assert.equal(summary.closed, 2);
    near(summary.netPnlUSDT, 19.72);
    const a = summarizeObservationPerformance([trackedOld, trackedBoth], { candidateId: 'A', now: 2 * MINUTE });
    assert.equal(a.total, 1);
    near(a.netPnlUSDT, 9.86);
  });

  it('keeps rule versions, delivered states, candidate groups and final strategy attribution separate', () => {
    const source = row();
    const closed = withState(source, evaluate(source, [candle(1, { low: 89 })]));
    const open = withState(source, evaluate(source, [candle(1)]));
    const otherStrategy = { ...closed, strategy: 'resonance_SELL' };
    const old = { ...closed, raw_features: { observation: { ...closed.raw_features.observation, version: 'old' } } };
    const failed = { ...closed, delivery_status: 'failed' };
    const onlyA = { ...closed, raw_features: { observation: { ...closed.raw_features.observation, candidates: ['A'] } } };
    const summary = summarizeObservationPerformance([closed, open, otherStrategy, old, failed, onlyA], {
      candidateId: 'B', strategy: 'donchian_breakout', now: 2 * MINUTE });
    assert.equal(summary.total, 2);
    assert.equal(summary.closed, 1);
    assert.equal(summary.open, 1);
    near(summary.netPnlUSDT, 9.86);
    assert.equal(summary.incomplete, false);
    assert.equal(summary.referenceNotionalUSDT, 100);
    assert.equal(summary.firstObservedAt, iso(1000));
  });

  it('shows no realized result before a completed reference and flags missing or stale outcomes', () => {
    const noSamples = summarizeObservationPerformance([], { candidateId: 'A', now: 0 });
    assert.equal(noSamples.netPnlUSDT, null);
    assert.equal(noSamples.sampleStatus, 'no_samples');
    const source = row();
    const state = evaluate(source, [candle(1)], [], 3 * MINUTE);
    const summary = summarizeObservationPerformance([withState(source, state)], { candidateId: 'A', now: 3 * MINUTE });
    assert.equal(summary.netPnlUSDT, null);
    assert.equal(summary.open, 1);
    assert.equal(summary.incomplete, true);
    assert.equal(summary.sampleStatus, 'incomplete');
    const notReviewed = summarizeObservationPerformance([row()], { candidateId: 'A', now: 3 * MINUTE });
    assert.equal(notReviewed.pending, 1);
    assert.equal(notReviewed.netPnlUSDT, null);
    assert.equal(notReviewed.incomplete, true);
  });
});

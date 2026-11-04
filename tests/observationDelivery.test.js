import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkSymbol } from '../api/lib/checker.js';
import { SignalStore } from '../src/db/signalStore.js';
import { prepareObservationDelivery } from '../src/signal/observationDelivery.js';

const config = { SUPABASE: { ENABLED: false }, MONITOR_TIERS: { tier1: { symbols: ['TESTUSDT'], cooldownMinutes: 120 } } };
const fixture = () => ({ symbol: 'TESTUSDT', strategy: 'donchian_breakout', signal: 'SELL', confidence: 80,
  suggestedEntry: 99, stopLoss: 102, targetPrice: 95,
  candle_close_time: new Date(Date.now() - 1000).toISOString(),
  raw_features: { currentPrice: 99, sma_50: 101, currentVolume: 150, volume_ma_20: 100,
    atr_14: 1, donchian: { lower: 99.3 } } });

describe('Observation alert delivery integration', () => {
  it('saves one watch-only A+B signal and sends once through the production checker', async () => {
    const signal = fixture();
    const store = new SignalStore({ config });
    const sent = [];
    const options = { config, store, candleFetcher: async () => [],
      engine: { evaluate: () => ({ eligible: true, signals: [signal], indicators: { currentPrice: 99 } }) },
      priceFetcher: async () => ({ price: '99.2' }), performance: { rows: [], available: true },
      sendEmail: async value => { sent.push(value); return true; } };
    const first = await checkSymbol('TESTUSDT', options);
    assert.equal(first.newSignals, 1);
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].observation_candidates, ['A', 'B']);
    const row = store.memoryStore.values().next().value.row;
    assert.equal(row.priority_action, 'watch_only');
    assert.equal(row.tracking_status, 'watch_only');
    assert.equal(row.delivery_status, 'delivered');
    assert.deepEqual(row.raw_features.observation.candidates, ['OLD', 'A', 'B']);
    assert.equal(row.strategy, signal.strategy);
    const second = await checkSymbol('TESTUSDT', options);
    assert.equal(second.deduplicated, 1);
    assert.equal(sent.length, 1);
  });

  it('retains old signals and records their separate OLD reference group', async () => {
    const signal = { ...fixture(), strategy: 'rsi_reversal', raw_features: { currentPrice: 101, sma_50: 100 } };
    const output = await prepareObservationDelivery([signal], {
      performance: { rows: [], available: true }, priceFetcher: async () => ({ price: '99' }),
    });
    assert.equal(output.length, 1);
    assert.equal(output[0].observation_only, undefined);
    assert.deepEqual(output[0].raw_features.observation.candidates, ['OLD']);
    assert.equal(output[0].observation_performance[0].candidateId, 'OLD');
    assert.equal(output[0].observation_performance[0].netPnlUSDT, null);
    assert.equal(output[0].observation_performance[0].closedTrades, 0);
  });

  it('keeps A and marks statistics unavailable if quote or performance services fail', async () => {
    const [signal] = await prepareObservationDelivery([fixture()], {
      performance: { rows: [], available: false }, priceFetcher: async () => { throw new Error('offline'); },
    });
    assert.deepEqual(signal.observation_candidates, ['A']);
    assert.equal(signal.observation_reference_price, null);
    assert.equal(signal.observation_performance[0].complete, false);
    assert.equal(signal.observation_performance[0].netPnlUSDT, null);
  });

  it('guards concurrent observation updates against overwriting a newer cursor', async () => {
    const calls = [];
    const query = {};
    for (const method of ['update', 'eq', 'is', 'select']) query[method] = (...args) => { calls.push([method, ...args]); return query; };
    query.abortSignal = async () => ({ data: [{ id: 1 }], error: null });
    const store = new SignalStore({ config, supabaseClient: { from: () => query } });
    const row = { id: 1, raw_features: { currentPrice: 99, observation: {
      version: 'ab-observation-v1', candidates: ['A'], evaluation: { checked_until: '2026-11-04T00:00:00.000Z' },
    } } };
    await store.saveObservationEvaluation(row, { checked_until: '2026-11-04T01:00:00.000Z' });
    assert.ok(calls.some(call => call[0] === 'eq' && call[1] === 'raw_features->observation->evaluation->>checked_until' && call[2] === '2026-11-04T00:00:00.000Z'));
    assert.equal(calls[0][1].raw_features.currentPrice, 99);
  });
});

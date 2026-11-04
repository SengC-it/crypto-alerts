import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { enrichObservationSignals, evaluateObservationCandidate, OBSERVATION_RULE_VERSION } from '../src/signal/observation.js';

const trigger = '2026-11-02T23:59:59.999Z';
const quoteTime = '2026-11-03T00:01:00.000Z';
function signal(overrides = {}, features = {}) {
  return {
    symbol: 'BTCUSDT', strategy: 'donchian_breakout', signal: 'SELL', confidence: 90,
    candle_close_time: trigger, suggestedEntry: 99, stopLoss: 104, targetPrice: 90,
    raw_features: { currentPrice: 99, sma_50: 102, currentVolume: 130, volume_ma_20: 100,
      donchian: { lower: 100 }, atr_14: 2, ...features },
    ...overrides,
  };
}
const quote = { referencePrice: 99, referenceTime: quoteTime };

describe('Frozen A/B observation candidates', () => {
  it('adds both labels to one watch-only signal, preserving source and original risk levels', () => {
    const source = signal();
    const original = structuredClone(source);
    const result = enrichObservationSignals([source], quote);
    assert.equal(result.length, 1);
    assert.deepEqual(result[0].observation_candidates, ['A', 'B']);
    assert.equal(result[0].observation_only, true);
    assert.equal(result[0].priority, 'watch');
    assert.equal(result[0].priorityAction, 'watch_only');
    assert.equal(result[0].priorityRank, 1);
    assert.equal(result[0].strategy, source.strategy);
    assert.equal(result[0].suggestedEntry, source.suggestedEntry);
    assert.equal(result[0].stopLoss, source.stopLoss);
    assert.equal(result[0].targetPrice, source.targetPrice);
    assert.deepEqual(source, original);
    assert.deepEqual(result[0].raw_features.observation, {
      version: OBSERVATION_RULE_VERSION, candidates: ['A', 'B'], trigger_time: trigger,
      reference_price: 99, reference_time: quoteTime,
    });
  });

  it('requires SELL, a close below SMA50 and at least 1.3 times volume for A', () => {
    for (const source of [signal({ signal: 'BUY' }), signal({}, { currentPrice: 102 }),
      signal({}, { currentVolume: 129 }), signal({}, { volume_ma_20: 0 }),
      signal({}, { currentPrice: null }), signal({}, { sma_50: null }),
      signal({}, { currentVolume: null }), signal({}, { volume_ma_20: null })]) {
      assert.deepEqual(enrichObservationSignals([source], quote), []);
    }
    assert.deepEqual(enrichObservationSignals([signal()], quote)[0].observation_candidates, ['A', 'B']);
  });

  it('does not use the trigger close or suggested entry as a missing live quote', () => {
    const result = enrichObservationSignals([signal()]);
    assert.deepEqual(result[0].observation_candidates, ['A']);
    assert.equal(result[0].observation_reference_price, null);
    assert.equal(result[0].observation_reference_time, null);
    assert.deepEqual(enrichObservationSignals([signal()], { referencePrice: 99 })[0].observation_candidates, ['A']);
    assert.deepEqual(enrichObservationSignals([signal()], { referencePrice: null, referenceTime: quoteTime })[0].observation_candidates, ['A']);
  });

  it('checks B against the live quote and includes exactly 0 to 0.5 ATR of extension', () => {
    for (const price of [100, 99]) {
      assert.deepEqual(enrichObservationSignals([signal()], { ...quote, referencePrice: price })[0].observation_candidates, ['A', 'B']);
    }
    for (const price of [100.001, 98.999, 0, null, NaN]) {
      assert.deepEqual(enrichObservationSignals([signal()], { ...quote, referencePrice: price })[0].observation_candidates, ['A']);
    }
  });

  it('requires a real Donchian contributor and actual trigger breakout for B', () => {
    assert.deepEqual(enrichObservationSignals([signal({ strategy: 'volume_confirmation' })], quote)[0].observation_candidates, ['A']);
    assert.deepEqual(enrichObservationSignals([signal({}, { currentPrice: 100.01 })], quote)[0].observation_candidates, ['A']);
    for (const contribution of [{ contributingStrategies: ['donchian_breakout'] },
      { contributing_evidence: [{ strategy: 'donchian_breakout' }] }]) {
      const source = signal({ strategy: 'resonance_SELL', ...contribution });
      assert.deepEqual(enrichObservationSignals([source], quote)[0].observation_candidates, ['A', 'B']);
    }
  });

  it('does not establish B without valid fixed trigger ATR and lower channel', () => {
    for (const features of [{ atr_14: null }, { atr_14: 0 }, { donchian: null }, { donchian: { lower: null } }]) {
      assert.deepEqual(enrichObservationSignals([signal({}, features)], quote)[0].observation_candidates, ['A']);
    }
  });

  it('rejects a quote predating the trigger, while keeping unknown timestamps explicit', () => {
    const prior = { ...quote, referenceTime: '2026-11-02T23:00:00.000Z' };
    assert.deepEqual(enrichObservationSignals([signal()], prior), []);
    assert.deepEqual(enrichObservationSignals([signal()], { ...quote, referenceTime: 'invalid' })[0].observation_candidates, ['A']);
    assert.deepEqual(enrichObservationSignals([signal({ candle_close_time: null })], quote), []);
    assert.deepEqual(enrichObservationSignals([signal({ candle_close_time: Number.MAX_VALUE })], quote), []);
    assert.deepEqual(enrichObservationSignals([signal()], { ...quote, referenceTime: Number.MAX_VALUE })[0].observation_candidates, ['A']);
    assert.equal(evaluateObservationCandidate(signal(), prior).rejectionReasons.A.includes('quote_before_trigger'), true);
  });

  it('resolves quotes independently by symbol without borrowing another symbol quote', () => {
    const result = enrichObservationSignals([signal(), signal({ symbol: 'ETHUSDT' })], {
      referencePrice: { BTCUSDT: 99 }, referenceTime: { BTCUSDT: quoteTime },
    });
    assert.deepEqual(result.map(item => item.observation_candidates), [['A', 'B'], ['A']]);
    assert.equal(result[1].raw_features.observation.reference_price, null);
  });
});

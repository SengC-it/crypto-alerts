import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  M1_FROZEN_HOLDOUT,
  M11_EVIDENCE_GROUPS,
  applyEventPolicy,
  buildAblationMatrix,
  calculateConcentration,
  diagnoseSideways,
  fitHorizonPolicy,
  fitM11Policy,
  fitM11VolatilityPolicy,
  fitScorePolicy,
  freezeM1DevelopmentRecords,
  predictM11Selections,
  promotionDiagnostics,
  runM11Candidate,
  scoreWithPolicy,
} from '../src/v2/edgeDiscovery.js';
import { runPurgedWalkForward } from '../src/v2/walkForward.js';

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2025, 0, 1);

function sample(index, {
  setup = 'Trend Continuation',
  direction = 'BUY',
  trend = 'Bull',
  volatility = 'Normal',
  event = `event-${index}`,
  outcomes = {},
  groups = ['Trend', 'Momentum'],
} = {}) {
  const net = Object.fromEntries([1, 4, 8, 12, 24, 48].map(horizon => [
    `${horizon}h`, outcomes[horizon] ?? -0.1,
  ]));
  const gross = Object.fromEntries(Object.entries(net).map(([key, value]) => [key, value + 0.14]));
  return {
    record_index: index,
    timestamp: START + index * HOUR,
    label_end_time: START + (index + 48) * HOUR,
    market_event_id: event,
    symbol: index % 2 ? 'ETHUSDT' : 'BTCUSDT',
    direction,
    setup_family: setup,
    trend_regime: trend,
    volatility_regime: volatility,
    raw_score: 50 + (index % 5),
    edge_score: 50 + (index % 5),
    evidence_groups: groups,
    evidence_by_group: groups.map(group => ({ group, strength: group === 'Momentum' ? 0.5 : 1 })),
    forward_returns: gross,
    net_forward_returns: net,
    mfe_percent: 1,
    mae_percent: -0.5,
    barrier_outcome: outcomes[1] > 0 ? 'tp_first' : 'sl_first',
    conservative_barrier_outcome: outcomes[1] > 0 ? 'tp_first' : 'sl_first',
    tp_first: outcomes[1] > 0,
    sl_first: outcomes[1] <= 0,
  };
}

describe('M1.1 train-only policy fitting', () => {
  it('selects different setup horizons from training outcomes', () => {
    const train = [
      ...Array.from({ length: 40 }, (_, index) => sample(index, {
        setup: 'Trend Continuation',
        outcomes: { 1: -0.1, 4: -0.1, 8: 0.6, 12: 0.4, 24: 0.2, 48: 0.1 },
      })),
      ...Array.from({ length: 40 }, (_, index) => sample(index + 40, {
        setup: 'Breakout',
        outcomes: { 1: -0.1, 4: 0.7, 8: 0.1, 12: 0.05, 24: 0, 48: -0.1 },
      })),
    ];
    const policy = fitHorizonPolicy(train, {
      minimumSamples: 20,
      minimumIndependentClusters: 10,
    });
    assert.equal(policy.training_only, true);
    assert.equal(policy.selected_by_setup['Trend Continuation'], 8);
    assert.equal(policy.selected_by_setup.Breakout, 4);
  });

  it('uses the predefined fallback when training evidence is insufficient', () => {
    const policy = fitHorizonPolicy([sample(0), sample(1)], {
      minimumSamples: 20,
      minimumIndependentClusters: 10,
      fallbackHorizon: 4,
    });
    assert.equal(policy.selected_by_setup['Trend Continuation'], 4);
    assert.equal(policy.per_setup['Trend Continuation'].fallback_used, true);
  });

  it('does not change a fitted score policy when only test outcomes change', () => {
    const train = Array.from({ length: 40 }, (_, index) => sample(index, {
      outcomes: { 1: 0.4, 4: 0.4, 8: 0.4, 12: 0.4, 24: 0.4, 48: 0.4 },
    }));
    const test = Array.from({ length: 10 }, (_, index) => sample(index + 100));
    const before = fitScorePolicy(train, { method: 'empirical_global' });
    for (const item of test) item.net_forward_returns = Object.fromEntries(M11_EVIDENCE_GROUPS.map(group => [group, -999]));
    const after = fitScorePolicy(train, { method: 'empirical_global' });
    assert.deepEqual(after, before);
  });

  it('does not change fitted horizon, event or volatility policies from test outcomes', () => {
    const train = Array.from({ length: 50 }, (_, index) => sample(index, {
      outcomes: { 1: 0.2, 4: 0.3, 8: 0.1, 12: 0.1, 24: 0, 48: -0.1 },
    }));
    const test = Array.from({ length: 20 }, (_, index) => sample(index + 100));
    const first = fitM11Policy(train, {
      score_method: 'empirical_global',
      event_policy: 'train_select',
      cluster_top_n: 'train_select',
    });
    for (const item of test) {
      item.net_forward_returns = { '1h': 100, '4h': 100, '8h': 100, '12h': 100, '24h': 100, '48h': 100 };
    }
    const second = fitM11Policy(train, {
      score_method: 'empirical_global',
      event_policy: 'train_select',
      cluster_top_n: 'train_select',
    });
    assert.deepEqual(second, first);
    const volatility = fitM11VolatilityPolicy(train.map(item => ({ ...item, primary_outcome: 0.1 })));
    assert.equal(volatility.training_only, true);
  });
});

describe('M1.1 event, scoring and holdout boundaries', () => {
  it('uses point-in-time event buckets and preserves record outcomes', () => {
    const records = [sample(0), sample(1)];
    const grouped = applyEventPolicy(records, 1);
    assert.notEqual(grouped[0].market_event_id, grouped[1].market_event_id);
    assert.deepEqual(grouped[0].net_forward_returns, records[0].net_forward_returns);
  });

  it('deduplicates correlated evidence before scoring', () => {
    const policy = fitScorePolicy([], { method: 'equal_weight' });
    const duplicated = sample(0, { groups: ['Trend'] });
    duplicated.evidence_by_group = [
      { group: 'Trend', strength: 1 },
      { group: 'Trend', strength: 0.2 },
    ];
    const single = { ...duplicated, evidence_by_group: [{ group: 'Trend', strength: 1 }] };
    assert.equal(scoreWithPolicy(duplicated, policy), scoreWithPolicy(single, policy));
  });

  it('never reads an old holdout outcome while freezing development records', () => {
    const holdout = { timestamp: M1_FROZEN_HOLDOUT.boundary_timestamp + HOUR };
    Object.defineProperty(holdout, 'net_forward_returns', {
      get() {
        throw new Error('old holdout outcome was accessed');
      },
    });
    const development = freezeM1DevelopmentRecords([
      sample(0),
      holdout,
    ]);
    assert.equal(development.length, 1);
    assert.equal(development[0].record_index, 0);
  });

  it('keeps the new final holdout out of every WFO train and test window', () => {
    const records = Array.from({ length: 400 }, (_, index) => sample(index, {
      event: `event-${index}`,
      outcomes: { 1: 0.2, 4: 0.2, 8: 0.2, 12: 0.2, 24: 0.2, 48: 0.2 },
    }));
    const result = runM11Candidate(records, {
      candidateId: 'test-holdout-isolation',
      candidate: {
        score_method: 'equal_weight',
        event_policy: '4h',
        event_window_hours: 4,
        cluster_top_n: 1,
      },
      wfoOptions: {
        trainSize: 100,
        testSize: 12,
        step: 12,
        finalHoldoutCount: 30,
        minimumTrainSamples: 20,
        minimumWindows: 6,
      },
    });
    assert.equal(result.final_holdout_untouched, true);
    assert.ok(result.walk_forward.final_holdout_start > result.oos_records.at(-1).timestamp);
    assert.ok(result.oos_records.every(record => record.timestamp < result.walk_forward.final_holdout_start));
  });

  it('does not read new final holdout outcomes when hashing the holdout', () => {
    const records = Array.from({ length: 180 }, (_, index) => ({
      timestamp: START + index * HOUR,
      market_event_id: `event-${index}`,
      symbol: 'BTCUSDT',
      direction: 'BUY',
      raw_score: 80,
      outcome: index < 150 ? 0.2 : undefined,
    }));
    for (const record of records.slice(150)) {
      Object.defineProperty(record, 'outcome', {
        enumerable: false,
        get() {
          throw new Error('new final holdout outcome was accessed');
        },
      });
    }
    const result = runPurgedWalkForward(records, {
      trainSize: 80,
      testSize: 10,
      step: 10,
      finalHoldoutCount: 30,
      purgeHours: 48,
      embargoHours: 24,
      labelHorizonHours: 48,
      minimumTrainSamples: 20,
      minimumWindows: 6,
      includeFinalHoldoutOutcomeInHash: false,
    });
    assert.equal(result.final_holdout_untouched, true);
    assert.equal(typeof result.final_holdout_hash, 'string');
  });
});

describe('M1.1 metrics and bounded promotion', () => {
  it('diagnoses Sideways suppression from generation and OOS audit counts', () => {
    const result = diagnoseSideways({
      generationDiagnostics: [{
        trigger_windows: 100,
        trend_regime_triggers: { Bull: 40, Bear: 40, Sideways: 20 },
        eligible_setup_candidates_by_trend: {
          Bull: { 'Trend Continuation': 20, 'Mean Reversion': 0, Breakout: 2 },
          Bear: { 'Trend Continuation': 20, 'Mean Reversion': 0, Breakout: 2 },
          Sideways: { 'Trend Continuation': 0, 'Mean Reversion': 0, Breakout: 0 },
        },
      }],
      oosRecords: [],
    });
    assert.equal(result.generation.sideways_trigger_windows, 20);
    assert.equal(result.generation.sideways_mean_reversion_candidates, 0);
    assert.equal(result.conclusion, 'B_MEAN_REVERSION_SETUP_TOO_RESTRICTIVE');
  });

  it('reports symbol and regime concentration without manufacturing records', () => {
    const records = [
      ...Array.from({ length: 8 }, (_, index) => sample(index, { trend: 'Bull' })),
      ...Array.from({ length: 2 }, (_, index) => sample(index + 8, { trend: 'Bear' })),
    ];
    const result = calculateConcentration(records);
    assert.equal(result.max_symbol_cluster_share, 0.5);
    assert.equal(result.max_regime_cluster_share, 0.8);
    assert.equal(result.concentration_risk, true);
  });

  it('keeps primary metrics limited to cluster-selected OOS records', () => {
    const records = [
      { ...sample(0, { outcomes: { 1: 2 } }), selected: true },
      { ...sample(1, { outcomes: { 1: -2 } }), selected: false },
    ];
    const matrix = buildAblationMatrix(records, []);
    assert.equal(matrix.all.cluster_selected, 1);
    assert.equal(matrix.all.net_expectancy_percent, 2);
    assert.equal(matrix.all.candidates, 2);
  });

  it('adds the fixed positive-window ratio guard without lowering gates', () => {
    const result = promotionDiagnostics({
      metrics: {
        independent_market_clusters: 120,
        net_profit_factor: 1.5,
        net_expectancy_percent: 0.3,
        symbol_breadth: 10,
        score_calibration: { status: 'PASS' },
      },
      walk_forward: { window_count: 6, positive_windows: 4 },
      stability: { positive_window_ratio: 0.5, unstable_edge: true },
      concentration: { concentration_risk: false },
    });
    assert.equal(result.recommendation, 'REJECT');
    assert.ok(result.failures.includes('positive_window_ratio'));
    assert.equal(result.thresholds.independentClusters, 100);
    assert.equal(result.thresholds.netProfitFactor, 1.25);
  });

  it('preserves the shadow-only production flags in the research protocol', () => {
    const model = fitM11Policy([sample(0), sample(1)], { score_method: 'equal_weight' });
    const predictions = predictM11Selections([sample(2)], model);
    assert.equal(model.training_only, true);
    assert.equal(predictions.length, 1);
    assert.equal(M1_FROZEN_HOLDOUT.final_holdout_hash.length, 64);
  });
});

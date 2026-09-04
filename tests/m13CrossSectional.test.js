import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildPurgedWalkForwardPlan } from '../src/v2/walkForward.js';
import {
  M13_CANDIDATE_BUDGET,
  M13_PREDECLARED_CANDIDATES,
  M13_MIN_VALID_SYMBOLS,
  M13_BETA_WINDOW_HOURS,
  M13_MIN_BETA_OBSERVATIONS,
  attachCrossSectionalDerivativeRanks,
  buildCrossSectionSnapshots,
  buildCrossSectionalFeatures,
  buildDirectionalSamples,
  compareM13Results,
  crossSectionNormalize,
  evaluateAbsolutePromotionGate,
  fitM13Policy,
  independentMarketEventId,
  m13CandidateConfigHash,
  predictM13Selections,
  scoreCrossSectionalCandidate,
  summarizeM13Records,
} from '../src/v2/crossSectional.js';

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2025, 0, 1);
const SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT',
  'AVAXUSDT', 'LINKUSDT', 'DOTUSDT', 'ARBUSDT', 'NEARUSDT', 'LTCUSDT',
  'ATOMUSDT', 'UNIUSDT', 'APTUSDT', 'STXUSDT', 'IMXUSDT', 'AAVEUSDT',
];

function candle(symbol, symbolIndex, index, overrides = {}) {
  const openTime = START + index * HOUR;
  const close = 100 + symbolIndex * 0.3 + index * 0.05 + Math.sin(index / 7 + symbolIndex) * 2;
  return {
    symbol,
    open: close - 0.1,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000 + symbolIndex * 10 + (index % 11) * 3,
    quote_volume: close * (1000 + symbolIndex * 10 + (index % 11) * 3),
    taker_buy_volume: 520,
    open_time: openTime,
    close_time: openTime + HOUR - 1,
    timeframe: '1h',
    is_closed: true,
    ...overrides,
  };
}

function candlesBySymbol(count = 240) {
  return Object.fromEntries(SYMBOLS.map((symbol, symbolIndex) => [
    symbol,
    Array.from({ length: count }, (_, index) => candle(symbol, symbolIndex, index)),
  ]));
}

function featureAt(features, index = 220, symbol = 'BTCUSDT') {
  const timestamp = START + index * HOUR + HOUR - 1;
  return features.features.find(row => row.timestamp === timestamp && row.symbol === symbol);
}

function comparisonFixtures({ candidateSelected = true, baselineSelected = false, candidateOffset = 0 } = {}) {
  const make = selected => Array.from({ length: 120 }, (_, index) => ({
    record_index: index,
    window_index: index % 6,
    timestamp: START + index * FOUR_HOURS,
    snapshot_event_id: `snapshot-${index}`,
    independent_market_event_id: `event-${index}`,
    market_event_id: `event-${index}`,
    symbol: index % 2 ? 'ETHUSDT' : 'BTCUSDT',
    direction: 'BUY',
    selected,
    primary_horizon_hours: 8,
    primary_outcome: selected ? 0.2 + candidateOffset : null,
    net_forward_returns: { '8h': selected ? 0.2 + candidateOffset : null },
    forward_returns: { '8h': selected ? 0.34 + candidateOffset : null },
    raw_score: 60,
    edge_score: 60,
  }));
  const baselineRecords = make(baselineSelected);
  const candidateRecords = make(candidateSelected).map(record => ({ ...record, primary_outcome: candidateSelected ? 0.2 + candidateOffset : null }));
  return {
    baseline: { oos_records: baselineRecords, selected_records: baselineRecords.filter(record => record.selected), walk_forward: { options: { testSize: 1 } }, stability: { positive_window_ratio: 0.5 }, concentration: { max_symbol_event_share: 0.2 } },
    candidate: { oos_records: candidateRecords, selected_records: candidateRecords.filter(record => record.selected), walk_forward: { options: { testSize: 1 } }, stability: { positive_window_ratio: 0.5 }, concentration: { max_symbol_event_share: 0.2 } },
  };
}

const FOUR_HOURS = 4 * HOUR;

describe('M1.3 cross-sectional timestamp and PIT features', () => {
  it('creates one exact closed-candle snapshot and fixed 4h event id per timestamp', () => {
    const result = buildCrossSectionSnapshots({ candlesBySymbol: candlesBySymbol(3) });
    assert.equal(result.snapshots.length, 3);
    assert.equal(result.snapshots[0].valid_symbol_count, SYMBOLS.length);
    assert.equal(new Set(result.snapshots.map(snapshot => snapshot.snapshot_event_id)).size, 3);
    assert.equal(result.snapshots[0].independent_market_event_id, independentMarketEventId(START));
    assert.equal(independentMarketEventId(START), independentMarketEventId(START + HOUR));
  });

  it('excludes an explicitly unfinished candle from cross-sectional breadth', () => {
    const data = candlesBySymbol(2);
    SYMBOLS.slice(0, 7).forEach(symbol => { data[symbol][1].is_closed = false; });
    const result = buildCrossSectionSnapshots({ candlesBySymbol: data, minValidSymbols: M13_MIN_VALID_SYMBOLS });
    assert.equal(result.snapshots.length, 1);
    assert.equal(result.rejected_snapshots[0].rejection_reason, 'INSUFFICIENT_CROSS_SECTION_BREADTH');
  });

  it('fails closed when fewer than 12 symbols share a timestamp', () => {
    const data = Object.fromEntries(SYMBOLS.slice(0, 11).map((symbol, symbolIndex) => [
      symbol,
      Array.from({ length: 3 }, (_, index) => candle(symbol, symbolIndex, index)),
    ]));
    const result = buildCrossSectionSnapshots({ candlesBySymbol: data });
    assert.equal(result.snapshots.length, 0);
    assert.equal(result.rejected_snapshots.length, 3);
    assert.equal(result.rejected_snapshots[0].rejection_reason, 'INSUFFICIENT_CROSS_SECTION_BREADTH');
  });

  it('uses deterministic symbol ordering for tied rank values', () => {
    const normalized = crossSectionNormalize([
      { symbol: 'ETHUSDT', value: 1 },
      { symbol: 'BTCUSDT', value: 1 },
      { symbol: 'SOLUSDT', value: 0 },
    ]);
    assert.equal(normalized.find(item => item.symbol === 'BTCUSDT').rank, 1);
    assert.equal(normalized.find(item => item.symbol === 'ETHUSDT').rank, 2);
    assert.equal(normalized.find(item => item.symbol === 'BTCUSDT').zscore > 0, true);
  });

  it('keeps prior ranks, beta and lead-lag values unchanged when future candles are appended', () => {
    const base = buildCrossSectionalFeatures({ candlesBySymbol: candlesBySymbol(240) });
    const extended = buildCrossSectionalFeatures({ candlesBySymbol: candlesBySymbol(260) });
    const before = featureAt(base);
    const after = featureAt(extended);
    for (const field of ['relative_momentum_8h', 'relative_momentum_8h_rank', 'residual_momentum_8h', 'beta_168h', 'lead_lag_continuation']) {
      assert.equal(after[field], before[field], field);
    }
    assert.equal(before.future_data_used, false);
  });

  it('fits a past-only 168h rolling beta only after the minimum observations', () => {
    const result = buildCrossSectionalFeatures({ candlesBySymbol: candlesBySymbol(240) });
    const row = featureAt(result, 220);
    assert.equal(result.beta_window_hours, M13_BETA_WINDOW_HOURS);
    assert.equal(result.beta_minimum_observations, M13_MIN_BETA_OBSERVATIONS);
    assert.equal(row.beta_fitted, true);
    assert.ok(row.beta_observations >= M13_MIN_BETA_OBSERVATIONS);
  });

  it('normalizes each factor only within the same timestamp', () => {
    const result = buildCrossSectionalFeatures({ candlesBySymbol: candlesBySymbol(240) });
    const rows = result.features.filter(row => row.timestamp === START + 220 * HOUR + HOUR - 1);
    assert.equal(rows.length, SYMBOLS.length);
    assert.equal(new Set(rows.map(row => row.relative_momentum_8h_rank)).size, rows.length);
    assert.ok(Math.abs(rows.reduce((sum, row) => sum + (row.relative_momentum_8h_zscore || 0), 0)) < 1e-9);
  });

  it('ranks optional derivatives cross-sectionally without reading outcomes', () => {
    const result = buildCrossSectionalFeatures({ candlesBySymbol: candlesBySymbol(180) });
    const rows = result.features.filter(row => row.timestamp === START + 170 * HOUR + HOUR - 1);
    rows.forEach((row, index) => {
      row.primary_outcome = 999999;
      row.derivatives = { Funding: { representative_value: index } };
    });
    attachCrossSectionalDerivativeRanks(rows, { families: ['Funding'] });
    assert.equal(rows.filter(row => row.derivative_rank_valid).length, rows.length);
    assert.equal(rows.find(row => row.derivative_rank === 1).derivative_rank, 1);
  });
});

describe('M1.3 independent generator and selection contract', () => {
  it('keeps the candidate budget at exactly the twelve predeclared X0-X11 lanes', () => {
    assert.equal(M13_PREDECLARED_CANDIDATES.length, M13_CANDIDATE_BUDGET);
    assert.equal(M13_PREDECLARED_CANDIDATES.at(0).candidate_id.startsWith('X0-'), true);
    assert.equal(M13_PREDECLARED_CANDIDATES.at(-1).candidate_id.startsWith('X11-'), true);
  });

  it('maps positive and negative relative momentum to opposite directions', () => {
    const row = { relative_momentum_8h: 0.01 };
    const buy = scoreCrossSectionalCandidate(row, 'X1-relative-momentum', 'BUY');
    const sell = scoreCrossSectionalCandidate(row, 'X1-relative-momentum', 'SELL');
    assert.ok(buy.raw_score > 50);
    assert.ok(sell.raw_score < 50);
  });

  it('selects an independently generated candidate when a frozen baseline has no selection', () => {
    const samples = [
      { record_index: 1, snapshot_event_id: 'snapshot-1', independent_market_event_id: 'event-1', symbol: 'BTCUSDT', direction: 'BUY', raw_score: 70, edge_score: 70, point_in_time: true },
      { record_index: 2, snapshot_event_id: 'snapshot-1', independent_market_event_id: 'event-1', symbol: 'ETHUSDT', direction: 'BUY', raw_score: 80, edge_score: 80, point_in_time: true },
      { record_index: 3, snapshot_event_id: 'snapshot-1', independent_market_event_id: 'event-1', symbol: 'BTCUSDT', direction: 'SELL', raw_score: 65, edge_score: 65, point_in_time: true },
    ];
    const selected = predictM13Selections(samples, { cluster_top_n: 1 });
    assert.equal(selected.filter(item => item.selected).length, 2);
    assert.equal(selected.find(item => item.selected && item.sample.direction === 'BUY').sample.symbol, 'ETHUSDT');
    assert.equal(selected.find(item => item.selected && item.sample.direction === 'SELL').sample.symbol, 'BTCUSDT');
  });

  it('generates both directions with point-in-time barriers and all required horizons', () => {
    const featureResult = buildCrossSectionalFeatures({ candlesBySymbol: candlesBySymbol(230) });
    const rows = featureResult.features.filter(row => row.timestamp >= START + 200 * HOUR);
    const samples = buildDirectionalSamples({ featureRows: rows, candlesBySymbol: candlesBySymbol(230), candidateId: 'X1-relative-momentum' });
    assert.equal(samples.length, rows.length * 2);
    assert.deepEqual([...new Set(samples.map(sample => sample.direction))].sort(), ['BUY', 'SELL']);
    assert.ok(samples.every(sample => sample.point_in_time && sample.future_data_used === false));
    assert.deepEqual(Object.keys(samples[0].net_forward_returns).sort(), ['12h', '1h', '24h', '4h', '48h', '8h'].sort());
    assert.equal(samples[0].barrier_version, 'm1-research-natr-barriers-0.1.0');
  });
});

describe('M1.3 outcome-independent support and gates', () => {
  it('uses independent 4h events, not rows, as the bootstrap unit and scores abstention as zero', () => {
    const { baseline, candidate } = comparisonFixtures();
    const comparison = compareM13Results(baseline, candidate, { repetitions: 100, seed: 20260904 });
    assert.equal(comparison.bootstrap.unit, 'independent_market_event_id');
    assert.equal(comparison.bootstrap.unit_count, 120);
    assert.equal(comparison.paired_independent_market_events, 120);
    assert.equal(comparison.paired_event_outcomes[0].baseline_net_expectancy, 0);
    assert.equal(comparison.paired_event_outcomes[0].candidate_net_expectancy, 0.2);
  });

  it('keeps common support unchanged when only OOS outcomes change', () => {
    const first = comparisonFixtures();
    const second = comparisonFixtures({ candidateOffset: 1000 });
    const left = compareM13Results(first.baseline, first.candidate, { repetitions: 25 });
    const right = compareM13Results(second.baseline, second.candidate, { repetitions: 25 });
    assert.deepEqual(right.paired_event_ids, left.paired_event_ids);
    assert.equal(right.common_support_comparison.common_support_outcome_independent, true);
  });

  it('fits a fixed train-only policy without consulting labels', () => {
    const train = [{ timestamp: START, edge_score: 50, primary_outcome: 0.1 }, { timestamp: START + HOUR, edge_score: 60, primary_outcome: -0.1 }];
    const before = fitM13Policy(train, 'X2-residual-momentum');
    train.forEach(sample => { sample.primary_outcome = 999999; sample.net_forward_returns = { '8h': -999999 }; });
    const after = fitM13Policy(train, 'X2-residual-momentum');
    assert.deepEqual(after, before);
    assert.equal(after.label_fields_not_read, true);
  });

  it('does not include final holdout outcomes in the WFO hash or policy inputs', () => {
    const samples = Array.from({ length: 180 }, (_, index) => ({
      timestamp: START + index * HOUR,
      market_event_id: `event-${index}`,
      snapshot_event_id: `snapshot-${index}`,
      symbol: 'BTCUSDT',
      direction: 'BUY',
      raw_score: 50,
      edge_score: 50,
      primary_outcome: index < 150 ? 0.1 : undefined,
    }));
    const first = buildPurgedWalkForwardPlan(samples, {
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
    samples.slice(-30).forEach(sample => { sample.primary_outcome = 999999; });
    const second = buildPurgedWalkForwardPlan(samples, {
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
    assert.equal(first.final_holdout_hash, second.final_holdout_hash);
    assert.equal(first.final_holdout_untouched, true);
    assert.equal(m13CandidateConfigHash({ candidate: { candidate_id: 'X1' }, wfoOptions: first.options, symbols: SYMBOLS }), m13CandidateConfigHash({ candidate: { candidate_id: 'X1' }, wfoOptions: first.options, symbols: SYMBOLS }));
  });

  it('keeps primary metrics restricted to selected OOS signals', () => {
    const records = [
      { selected: true, symbol: 'BTCUSDT', direction: 'BUY', independent_market_event_id: 'e1', primary_horizon_hours: 8, primary_outcome: 0.3, primary_gross_outcome_percent: 0.44, raw_score: 70 },
      { selected: false, symbol: 'ETHUSDT', direction: 'BUY', independent_market_event_id: 'e2', primary_horizon_hours: 8, primary_outcome: 99, primary_gross_outcome_percent: 99, raw_score: 99 },
    ];
    const metrics = summarizeM13Records(records, { primaryHorizonHours: 8 });
    assert.equal(metrics.selected_oos_signals, 1);
    assert.equal(metrics.net_expectancy_percent, 0.3);
    assert.equal(metrics.primary_metrics_selected_only, true);
  });

  it('reports absolute gate failures without changing the safety contract', () => {
    const gate = evaluateAbsolutePromotionGate({ metrics: { independent_market_events: 2, net_profit_factor: 0, net_expectancy_percent: -1, symbol_breadth: 1, score_calibration: { status: 'CALIBRATION_FAIL' } }, stability: { total_windows: 1, positive_windows: 0, positive_window_ratio: 0 }, concentration: { max_symbol_event_share: 1 } });
    assert.equal(gate.pass, false);
    assert.ok(gate.failures.includes('independent_events'));
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SignalEvaluator } from '../src/evaluation/signalEvaluator.js';
import { archiveAsOf, parseArchiveCsv } from '../src/backtest/binanceArchive.js';
import {
  aggregateClosedCandlesTo4h,
  canonicalClosedWindow,
  canonicalIndicators,
} from '../src/v2/canonical.js';
import { compareV1V2, assertBenchmarkParity } from '../src/v2/comparator.js';
import { deduplicateEvidence } from '../src/v2/evidence.js';
import { runM1Experiment } from '../src/v2/experiment.js';
import { groupMarketEvents, rankShadowCandidates } from '../src/v2/marketEvents.js';
import { summarizeEvaluations, toEvaluationRecord } from '../src/v2/metrics.js';
import { evaluatePromotionGate } from '../src/v2/promotion.js';
import { RegimeEngine } from '../src/v2/regime.js';
import { scoreCandidate, buildScoreCalibration } from '../src/v2/scoring.js';
import { breakoutSetup, evaluateSetupFamilies } from '../src/v2/setups.js';
import { buildV2ShadowSignal } from '../src/v2/shadow.js';
import { runPurgedWalkForward } from '../src/v2/walkForward.js';

const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;
const START = Date.UTC(2025, 0, 1);

function candle(index, close, {
  high = close + 1,
  low = close - 1,
  volume = 1000,
  timeframe = '1h',
  isClosed = true,
  symbol = 'BTCUSDT',
} = {}) {
  const step = timeframe === '4h' ? FOUR_HOURS : HOUR;
  const openTime = START + index * step;
  return {
    open: close,
    high,
    low,
    close,
    volume,
    open_time: openTime,
    close_time: openTime + step - 1,
    timeframe,
    is_closed: isClosed,
    symbol,
  };
}

function trendCandles(count = 180, symbol = 'BTCUSDT', phase = 0) {
  return Array.from({ length: count }, (_, index) => {
    const close = 100 + index * (0.12 + phase * 0.005) + Math.sin((index + phase) / 5) * 0.4;
    return candle(index, close, { symbol, volume: 1000 + index % 10 });
  });
}

function upContext(count = 32) {
  return Array.from({ length: count }, (_, index) => candle(index, 100 + index * 1.2, {
    timeframe: '4h',
  }));
}

function evaluation(direction, outcome, index = 0) {
  return {
    symbol: direction === 'BUY' ? 'BTCUSDT' : 'ETHUSDT',
    direction,
    forward_returns: { '1h': outcome + 0.14 },
    net_forward_returns: { '1h': outcome },
    mfe_percent: Math.max(0, outcome + 1),
    mae_percent: Math.min(0, outcome - 1),
    signal_decay: 0.1,
    tp_first: outcome > 0,
    sl_first: outcome <= 0,
    signal_timestamp: new Date(START + index * HOUR).toISOString(),
  };
}

describe('M1 regime and canonical timeframe contract', () => {
  it('classifies a closed 4h bullish context deterministically', () => {
    const trigger = trendCandles();
    const regime = new RegimeEngine().classify({
      triggerCandles: trigger,
      contextCandles: upContext(),
      asOf: trigger.at(-1).close_time + 1,
      symbol: 'BTCUSDT',
    });
    assert.equal(regime.trend_regime, 'Bull');
    assert.ok(['Low', 'Normal', 'High', 'Extreme'].includes(regime.volatility_regime));
    assert.equal(regime.trigger_timeframe, '1h');
    assert.equal(regime.context_timeframe, '4h');
    assert.equal(regime.lookahead_safe, true);
  });

  it('ignores an unfinished/future 4h context candle', () => {
    const trigger = trendCandles();
    const asOf = trigger.at(-1).close_time + 1;
    const safe = upContext();
    const poisoned = [...safe, candle(32, 1, {
      timeframe: '4h',
      isClosed: false,
    })];
    const engine = new RegimeEngine();
    const first = engine.classify({ triggerCandles: trigger, contextCandles: safe, asOf, symbol: 'BTCUSDT' });
    const second = engine.classify({ triggerCandles: trigger, contextCandles: poisoned, asOf, symbol: 'BTCUSDT' });
    assert.deepEqual(second, first);
  });

  it('aggregates only complete aligned 1h groups into closed 4h context', () => {
    const source = trendCandles(9);
    const aggregated = aggregateClosedCandlesTo4h(source, {
      symbol: 'BTCUSDT',
      asOf: source.at(-1).close_time + 1,
    });
    assert.equal(aggregated.length, 2);
    assert.equal(aggregated[0].source_candle_count, 4);
    assert.equal(aggregated[0].timeframe, '4h');
    assert.equal(aggregated[1].is_closed, true);
  });

  it('resolves exactly the M0 indicator window before V2 computation', () => {
    const candles = trendCandles(120);
    const window = canonicalClosedWindow(candles, {
      symbol: 'BTCUSDT',
      asOf: candles.at(-1).close_time + 1,
      lookbackCandles: 100,
    });
    const indicators = canonicalIndicators(window, { symbol: 'BTCUSDT', lookbackCandles: 100 });
    assert.equal(window.eligible, true);
    assert.equal(window.indicatorCandles.length, 100);
    assert.equal(indicators.currentPrice, candles.at(-1).close);
  });
});

describe('M1 public archive fallback', () => {
  it('parses Binance archive rows and anchors to the latest complete UTC day', () => {
    const csv = [
      'open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore',
      '1735689600000,100,102,99,101,1000,1735693199999,101000,10,500,50500,0',
    ].join('\n');
    const rows = parseArchiveCsv(csv, 'BTCUSDT', '1h');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].quote_volume, 101000);
    assert.equal(rows[0].is_closed, true);
    assert.equal(archiveAsOf(Date.UTC(2026, 8, 1, 12)), Date.UTC(2026, 8, 1) - 1);
  });
});

describe('M1 independent setup families', () => {
  it('uses only prior structure for breakout thresholds', () => {
    const prior = Array.from({ length: 20 }, (_, index) => candle(index, 100 + index * 0.1, {
      high: 101,
      low: 99,
    }));
    const current = candle(20, 103, { high: 104, low: 102 });
    const result = breakoutSetup([...prior, current]);
    assert.equal(result.eligible, true);
    assert.equal(result.direction, 'BUY');
    assert.equal(result.feature_values.prior_structure_high, 101);
    assert.notEqual(result.feature_values.prior_structure_high, current.high);
  });

  it('keeps setup eligibility independent by family and regime', () => {
    const candles = trendCandles(100);
    const results = evaluateSetupFamilies(candles, {
      trend_regime: 'Bull',
      volatility_regime: 'Normal',
    });
    assert.equal(results.length, 3);
    assert.deepEqual(results.map(result => result.setup_family), [
      'Trend Continuation',
      'Mean Reversion',
      'Breakout',
    ]);
    assert.equal(results[1].eligible, false);
    assert.equal(results[1].reason, 'REGIME_NOT_SIDEWAYS');
  });
});

describe('M1 evidence, ranking and market events', () => {
  it('deduplicates EMA, SMA and MACD into correlated evidence groups', () => {
    const result = deduplicateEvidence([
      { source: 'EMA-21', group: 'Trend', strength: 0.8, direction: 'BUY' },
      { source: 'SMA-50', group: 'Trend', strength: 0.6, direction: 'BUY' },
      { source: 'MACD', group: 'Momentum', strength: 0.7, direction: 'BUY' },
      { source: 'RSI', group: 'Momentum', strength: 0.4, direction: 'BUY' },
    ]);
    assert.equal(result.independent_group_count, 2);
    assert.deepEqual(result.groups_present, ['Trend', 'Momentum']);
    assert.equal(result.rejected.length, 2);
  });

  it('retains every candidate while ranking one market event', () => {
    const candidates = [
      { symbol: 'BTCUSDT', direction: 'BUY', trigger_time: START, raw_score: 90, edge_score: 90, setup_family: 'Breakout' },
      { symbol: 'ETHUSDT', direction: 'BUY', trigger_time: START + HOUR, raw_score: 80, edge_score: 80, setup_family: 'Trend Continuation' },
      { symbol: 'SOLUSDT', direction: 'BUY', trigger_time: START + 2 * HOUR, raw_score: 70, edge_score: 70, setup_family: 'Trend Continuation' },
      { symbol: 'XRPUSDT', direction: 'SELL', trigger_time: START + HOUR, raw_score: 95, edge_score: 95, setup_family: 'Breakout' },
    ];
    const events = groupMarketEvents(candidates);
    const ranked = rankShadowCandidates(candidates);
    assert.equal(events.length, 1);
    assert.equal(ranked.length, 4);
    assert.equal(new Set(ranked.map(candidate => candidate.market_event_id)).size, 1);
    assert.ok(ranked.every(candidate => candidate.status === 'SHADOW'));
    assert.equal(ranked.filter(candidate => candidate.ranking_bucket === 'ACTION_CANDIDATE').length, 1);
    assert.equal(ranked.find(candidate => candidate.symbol === 'BTCUSDT').cluster_rank, 1);
    assert.equal(ranked.find(candidate => candidate.symbol === 'XRPUSDT').same_direction_breadth, 1);
    assert.equal(ranked.find(candidate => candidate.symbol === 'BTCUSDT').cluster_size, 4);
  });

  it('produces deterministic ranking and never labels edge_score as probability', () => {
    const evidence = {
      accepted: [
        { group: 'Trend', strength: 1, weight: 0.5 },
        { group: 'Momentum', strength: 0.5, weight: 0.5 },
      ],
      independent_group_count: 2,
    };
    const first = scoreCandidate({ evidence });
    const second = scoreCandidate({ evidence });
    assert.deepEqual(first, second);
    assert.equal(first.score_semantics, 'ranking_score_not_probability');
    assert.equal(first.calibrated, false);
  });

  it('fails calibration when OOS evidence is too small', () => {
    const result = buildScoreCalibration([
      { raw_score: 80, outcome: 1 },
      { raw_score: 90, outcome: -1 },
    ]);
    assert.equal(result.status, 'CALIBRATION_FAIL');
    assert.equal(result.no_probability_claim, true);
  });
});

describe('M1 purged walk-forward and comparator', () => {
  it('applies purge and embargo while isolating final holdout', () => {
    const samples = Array.from({ length: 240 }, (_, index) => ({
      timestamp: START + index * HOUR,
      label_end_time: START + (index + 48) * HOUR,
      raw_score: 50 + (index % 10),
      outcome: index % 4 === 0 ? 1 : -0.1,
    }));
    let largestFitTimestamp = 0;
    const result = runPurgedWalkForward(samples, {
      trainSize: 80,
      testSize: 20,
      step: 20,
      finalHoldoutCount: 20,
      purgeHours: 48,
      embargoHours: 24,
      minimumTrainSamples: 25,
      fit: train => {
        largestFitTimestamp = Math.max(largestFitTimestamp, ...train.map(sample => sample.timestamp));
        return { threshold: 0 };
      },
      predict: test => test.map(sample => ({ sample, selected: true })),
    });
    assert.equal(result.status, 'PASS');
    assert.equal(result.window_count, 6);
    assert.equal(result.final_holdout_untouched, true);
    assert.ok(largestFitTimestamp < samples.at(-20).timestamp);
    assert.ok(result.windows.every(window => window.purged_count > 0 && window.embargoed_count > 0));
  });

  it('uses identical benchmark fields for V1 and V2 comparison', () => {
    const benchmark = {
      symbols: ['BTCUSDT'],
      candles: { timeframe: '1h', closed_only: true },
      evaluation_horizons: [1, 4, 8, 12, 24, 48],
      fees: { round_trip_percent: 0.14 },
      slippage: { included_in_round_trip_cost: true },
      market_event_window_hours: 4,
      date_range: { start: START, end: START + 100 * HOUR },
    };
    const v1Record = toEvaluationRecord({ symbol: 'BTCUSDT', direction: 'BUY' }, evaluation('BUY', 0.2));
    const v2Record = toEvaluationRecord({ symbol: 'BTCUSDT', direction: 'BUY', raw_score: 80 }, evaluation('BUY', 0.3));
    const comparison = compareV1V2({ benchmark, v1Records: [v1Record], v2Records: [v2Record] });
    assert.equal(comparison.same_data_contract, true);
    assert.equal(comparison.delta.net_expectancy_percent, 0.1);
    assert.equal(assertBenchmarkParity(benchmark, benchmark), true);
    assert.throws(() => compareV1V2({
      benchmark,
      v1Benchmark: benchmark,
      v2Benchmark: { ...benchmark, fees: { round_trip_percent: 0.15 } },
      v1Records: [v1Record],
      v2Records: [v2Record],
    }), /benchmark mismatch: fees/);
  });
});

describe('M1 shadow experiment boundary', () => {
  it('builds shadow-only candidates without changing V1 behavior', () => {
    const candles = trendCandles(180);
    const result = buildV2ShadowSignal({
      symbol: 'BTCUSDT',
      triggerCandles: candles,
      contextCandles: upContext(),
      asOf: candles.at(-1).close_time + 1,
      config: { INDICATOR_LOOKBACK_CANDLES: 100 },
      lineageOptions: { commitSha: 'test-commit' },
    });
    assert.equal(result.V1_UNCHANGED, true);
    assert.equal(result.V2_SHADOW_ONLY, true);
    assert.equal(result.AUTO_TRADING, false);
    assert.ok(result.candidates.length >= 1);
    assert.ok(result.candidates.every(candidate => candidate.status === 'SHADOW'));
    assert.ok(result.candidates.every(candidate => candidate.model_version.startsWith('m1-')));
  });

  it('returns an auditable insufficient-evidence result for non-production fixture data', () => {
    const candlesBySymbol = Object.fromEntries(
      ['BTCUSDT', 'ETHUSDT'].map((symbol, index) => [symbol, trendCandles(180, symbol, index)]),
    );
    const result = runM1Experiment({
      candlesBySymbol,
      asOf: START + 179 * HOUR + HOUR,
      config: {
        INDICATOR_LOOKBACK_CANDLES: 100,
        DEFAULT_STRATEGIES: {},
        TRADING_COSTS: { roundTripPercent: 0.14 },
      },
      dataSource: 'deterministic_test_fixture',
      experimentId: 'm1-test-fixture',
      walkForwardOptions: {
        trainSize: 60,
        testSize: 12,
        step: 12,
        finalHoldoutCount: 12,
        minimumTrainSamples: 20,
      },
    });
    assert.equal(result.experiment_id, 'm1-test-fixture');
    assert.equal(result.mode, 'SHADOW_ONLY');
    assert.equal(result.historical_coverage.complete, true);
    assert.equal(result.flags.AUTO_TRADING, false);
    assert.equal(result.promotion.recommendation, 'INSUFFICIENT_EVIDENCE');
    assert.ok(result.candidates.every(candidate => candidate.status === 'SHADOW'));
    const compact = runM1Experiment({
      candlesBySymbol,
      asOf: START + 179 * HOUR + HOUR,
      config: {
        INDICATOR_LOOKBACK_CANDLES: 100,
        DEFAULT_STRATEGIES: {},
        TRADING_COSTS: { roundTripPercent: 0.14 },
      },
      dataSource: 'deterministic_test_fixture',
      experimentId: 'm1-test-fixture-compact',
      includeArtifacts: false,
      walkForwardOptions: {
        trainSize: 60,
        testSize: 12,
        step: 12,
        finalHoldoutCount: 12,
        minimumTrainSamples: 20,
      },
    });
    assert.deepEqual(compact.metrics.v2, result.metrics.v2);
    assert.equal(compact.candidate_count, result.candidates.length);
    assert.equal(compact.v2_record_count, result.v2_records.length);
  });
});

describe('M1 metrics and promotion gate', () => {
  it('reports direction, regime, volatility and evaluator metrics separately', () => {
    const records = [
      toEvaluationRecord({ symbol: 'BTCUSDT', direction: 'BUY', trend_regime: 'Bull', volatility_regime: 'Normal', market_event_id: 'e1', raw_score: 60 }, evaluation('BUY', 0.2)),
      toEvaluationRecord({ symbol: 'ETHUSDT', direction: 'SELL', trend_regime: 'Bear', volatility_regime: 'High', market_event_id: 'e2', raw_score: 70 }, evaluation('SELL', -0.1, 1)),
    ];
    const metrics = summarizeEvaluations(records);
    assert.equal(metrics.independent_market_clusters, 2);
    assert.equal(metrics.symbol_breadth, 2);
    assert.equal(metrics.direction_breadth.BUY.sample_count, 1);
    assert.equal(metrics.direction_breadth.SELL.sample_count, 1);
    assert.equal(metrics.regime_breadth.Bull.sample_count, 1);
    assert.equal(metrics.volatility_breadth.High.sample_count, 1);
    assert.equal(metrics.forward_returns['48h'].count, 0);
  });

  it('does not reduce thresholds when evidence is insufficient', () => {
    const result = evaluatePromotionGate({
      metrics: {
        independent_market_clusters: 99,
        net_profit_factor: 100,
        net_expectancy_percent: 100,
        symbol_breadth: 8,
        evaluated_count: 99,
        score_calibration: { status: 'PASS' },
      },
      walkForward: { window_count: 6, positive_windows: 6 },
      calibration: { status: 'PASS' },
      dataSource: 'public_binance_futures',
    });
    assert.equal(result.recommendation, 'INSUFFICIENT_EVIDENCE');
    assert.equal(result.thresholds.independentClusters, 100);
  });
});

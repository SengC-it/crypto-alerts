import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  latestMetricsPerHour,
  parseFundingRows,
  parseMetricsRows,
  parsePremiumRows,
} from '../src/v2/derivativesData.js';
import {
  M12_DERIVATIVE_FAMILIES,
  M12_MAX_STALE_MS,
  attachPointInTimeDerivativeFeatures,
  buildDataAdmissionReport,
  buildPointInTimeFeatureIndex,
  fitDerivativeFamilyPolicy,
  fitDerivativePolicies,
  applyDerivativePolicies,
} from '../src/v2/microstructureFeatures.js';
import {
  M12_BOOTSTRAP_REPETITIONS,
  M12_CANDIDATE_BUDGET,
  M12_PREDECLARED_CANDIDATES,
  compareM12Candidates,
  evaluateInformationGainGate,
  fitM12Policy,
  M12_SAFETY_FLAGS,
} from '../src/v2/informationGain.js';
import { buildPurgedWalkForwardPlan } from '../src/v2/walkForward.js';

const HOUR = 60 * 60 * 1000;
const START = Date.UTC(2026, 0, 1);

function candle(index, overrides = {}) {
  const closeTime = START + index * HOUR;
  return {
    open: 100,
    high: 101,
    low: 99,
    close: 100 + index,
    volume: 1000,
    quote_volume: 100000,
    taker_buy_volume: 550,
    open_time: closeTime - HOUR + 1,
    close_time: closeTime,
    ...overrides,
  };
}

function completeDatasets({ funding = [], openInterest = [], premium = [], candles = [] } = {}) {
  return {
    fundingBySymbol: { BTCUSDT: funding },
    openInterestBySymbol: { BTCUSDT: openInterest },
    premiumBySymbol: { BTCUSDT: premium },
    candlesBySymbol: { BTCUSDT: candles },
  };
}

function attachedSample(index, values = {}) {
  const timestamp = START + index * HOUR;
  return {
    record_index: index,
    timestamp,
    symbol: 'BTCUSDT',
    direction: 'BUY',
    setup_family: 'Trend Continuation',
    trend_regime: 'Bull',
    volatility_regime: 'Normal',
    primary_outcome: values.outcome ?? 0.1,
    primary_gross_outcome_percent: (values.outcome ?? 0.1) + 0.14,
    derivatives: {
      Funding: { point_in_time_valid: true, representative_value: values.funding ?? index / 100 },
      'Open Interest': { point_in_time_valid: true, representative_value: values.oi ?? index / 100 },
      'Basis/Premium': { point_in_time_valid: true, representative_value: values.basis ?? index / 100 },
      'Taker Flow': { point_in_time_valid: true, representative_value: values.taker ?? index / 100 },
    },
  };
}

describe('M1.2 public derivative parsers and PIT rules', () => {
  it('parses public derivative timestamps and preserves the metrics source time', () => {
    const funding = parseFundingRows([
      'calc_time,funding_interval_hours,last_funding_rate',
      '2026-01-01 00:00:00,8,0.0001',
    ].join('\n'), 'BTCUSDT');
    const premium = parsePremiumRows([
      'open_time,open,high,low,close,volume,close_time,quote_volume,trades,taker_buy_base,taker_buy_quote,ignore',
      '1767222000000,0.0001,0.0002,0.0000,0.00015,1,1767225599999,2,3,4,5,0',
    ].join('\n'), 'BTCUSDT');
    const metrics = parseMetricsRows([
      'create_time,symbol,sum_open_interest,sum_open_interest_value',
      '2026-01-01 00:35:00,BTCUSDT,123.4,1234000',
    ].join('\n'), 'BTCUSDT');
    assert.equal(funding[0].source_timestamp, Date.UTC(2026, 0, 1));
    assert.equal(premium[0].premium, 0.00015);
    assert.equal(metrics[0].source_timestamp, Date.UTC(2026, 0, 1, 0, 35));
    assert.equal(metrics[0].sum_open_interest, 123.4);
  });

  it('keeps only the latest public OI row in each UTC hour without rewriting timestamps', () => {
    const rows = [
      { source_timestamp: START + 5 * 60 * 1000, open_interest: 1 },
      { source_timestamp: START + 55 * 60 * 1000, open_interest: 2 },
      { source_timestamp: START + HOUR + 5 * 60 * 1000, open_interest: 3 },
    ];
    const compact = latestMetricsPerHour(rows);
    assert.deepEqual(compact.map(row => row.open_interest), [2, 3]);
    assert.equal(compact[0].source_timestamp, START + 55 * 60 * 1000);
  });

  it('fails closed for future and stale observations instead of forward filling them', () => {
    const asOf = START + 3 * HOUR;
    const future = attachPointInTimeDerivativeFeatures([
      { symbol: 'BTCUSDT', timestamp: asOf },
    ], completeDatasets({
      funding: [{ source_timestamp: asOf + HOUR, availability_timestamp: asOf + HOUR, funding_rate: 0.1 }],
    }))[0];
    assert.equal(future.derivatives.Funding.point_in_time_valid, false);
    assert.equal(future.derivatives.Funding.invalid_reason, 'future_only_observation');
    assert.equal(future.derivatives.Funding.representative_value, null);

    const futureOtherFamilies = attachPointInTimeDerivativeFeatures([
      { symbol: 'BTCUSDT', timestamp: asOf },
    ], completeDatasets({
      openInterest: [{ source_timestamp: asOf + HOUR, availability_timestamp: asOf + HOUR, sum_open_interest: 100 }],
      premium: [{ source_timestamp: asOf + HOUR, availability_timestamp: asOf + HOUR, premium: 0.1 }],
    }))[0];
    assert.equal(futureOtherFamilies.derivatives['Open Interest'].invalid_reason, 'future_only_observation');
    assert.equal(futureOtherFamilies.derivatives['Basis/Premium'].invalid_reason, 'future_only_observation');

    const stale = attachPointInTimeDerivativeFeatures([
      { symbol: 'BTCUSDT', timestamp: START + 13 * HOUR },
    ], completeDatasets({
      funding: [{ source_timestamp: START, availability_timestamp: START, funding_rate: 0.1 }],
    }))[0];
    assert.equal(stale.derivatives.Funding.point_in_time_valid, false);
    assert.equal(stale.derivatives.Funding.invalid_reason, 'stale_data');

    const futureAvailability = attachPointInTimeDerivativeFeatures([
      { symbol: 'BTCUSDT', timestamp: asOf },
    ], completeDatasets({
      funding: [{ source_timestamp: START, availability_timestamp: asOf + 1, funding_rate: 0.1 }],
    }))[0];
    assert.equal(futureAvailability.derivatives.Funding.invalid_reason, 'future_availability_timestamp');
    assert.equal(futureAvailability.derivatives.Funding.stale_age_ms, undefined);
  });

  it('admission rejects incomplete families and records the non-admitted sources explicitly', () => {
    const report = buildDataAdmissionReport({
      symbols: ['BTCUSDT', 'ETHUSDT'],
      startTime: START,
      endTime: START + 3 * HOUR,
      datasets: { fundingBySymbol: {}, openInterestBySymbol: {}, premiumBySymbol: {}, candlesBySymbol: {} },
    });
    assert.deepEqual(report.admitted_families, []);
    assert.ok(report.rejected_families.includes('Funding'));
    assert.equal(report.liquidation.status, 'LIQUIDATION_DATA_NOT_ADMITTED');
    assert.equal(report.orderbook.status, 'NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK');
  });

  it('uses the completed kline taker fields at the signal timestamp', () => {
    const candles = Array.from({ length: 5 }, (_, index) => candle(index));
    const index = buildPointInTimeFeatureIndex({ candlesBySymbol: { BTCUSDT: candles } });
    const result = attachPointInTimeDerivativeFeatures([
      { symbol: 'BTCUSDT', timestamp: START + 3 * HOUR + 1 },
    ], index)[0];
    assert.equal(result.derivatives['Taker Flow'].point_in_time_valid, true);
    assert.equal(result.derivatives['Taker Flow'].taker_buy_volume, 550);
    assert.ok(result.derivatives['Taker Flow'].representative_value > 0);
    assert.deepEqual(result, attachPointInTimeDerivativeFeatures([
      { symbol: 'BTCUSDT', timestamp: START + 3 * HOUR + 1 },
    ], index)[0]);
  });
});

describe('M1.2 train-only family policies and paired comparison', () => {
  it('fits one representative per independent family and ignores test outcomes', () => {
    const train = Array.from({ length: 40 }, (_, index) => attachedSample(index, {
      outcome: index % 2 ? 0.2 : -0.1,
      funding: index / 100,
    }));
    const before = fitDerivativePolicies(train, ['Funding', 'Funding'], { minimumSamples: 10 });
    const test = attachedSample(100, { outcome: 999 });
    test.primary_outcome = -999;
    const after = fitDerivativePolicies(train, ['Funding', 'Funding'], { minimumSamples: 10 });
    assert.deepEqual(after, before);
    assert.deepEqual(before.families, ['Funding']);
    const applied = applyDerivativePolicies(test, before);
    assert.equal(Object.keys(applied.scores).length, 1);
    assert.equal(applied.all_valid, true);
    assert.equal(applied.normalized.Funding.training_only_scaler, true);
    assert.ok(Number.isFinite(applied.normalized.Funding.zscore));
    assert.ok(Number.isFinite(applied.normalized.Funding.percentile));

    const m12Before = fitM12Policy(train, { derivative_families: ['Funding'] });
    test.net_forward_returns = { '1h': 999 };
    const m12After = fitM12Policy(train, { derivative_families: ['Funding'] });
    assert.deepEqual(m12After, m12Before);
  });

  it('fails closed when the training policy is insufficient', () => {
    const policy = fitDerivativeFamilyPolicy([attachedSample(0)], 'Funding', { minimumSamples: 30 });
    assert.equal(policy.training_only, true);
    assert.equal(policy.fitted, false);
    const applied = applyDerivativePolicies(attachedSample(1), {
      families: ['Funding'],
      policies: { Funding: policy },
    });
    assert.equal(applied.all_valid, false);
    assert.deepEqual(applied.invalid_families, ['Funding']);
  });

  it('keeps the candidate space within the predeclared budget', () => {
    assert.equal(M12_PREDECLARED_CANDIDATES.length, 10);
    assert.ok(M12_PREDECLARED_CANDIDATES.length <= M12_CANDIDATE_BUDGET);
    assert.deepEqual(M12_DERIVATIVE_FAMILIES, ['Funding', 'Open Interest', 'Basis/Premium', 'Taker Flow']);
    assert.equal(M12_MAX_STALE_MS.Funding, 12 * HOUR);
  });

  it('produces a deterministic cluster bootstrap on common OOS support', () => {
    const makeResult = (values, offset) => {
      const records = values.map((value, index) => ({
        record_index: index,
        window_index: index % 2,
        market_event_id: `event-${index}`,
        direction: 'BUY',
        symbol: index % 2 ? 'ETHUSDT' : 'BTCUSDT',
        primary_outcome: value + offset,
        primary_gross_outcome_percent: value + offset + 0.14,
        selected: true,
      }));
      return {
        data_source: 'public_binance_futures_archive',
        selected_records: records,
        oos_records: records,
        walk_forward: { windows: [] },
      };
    };
    const baseline = makeResult([0.4, -0.2, 0.3, -0.1, 0.5, -0.2], 0);
    const augmented = makeResult([0.4, -0.2, 0.3, -0.1, 0.5, -0.2], 0.05);
    const first = compareM12Candidates(baseline, augmented);
    const second = compareM12Candidates(baseline, augmented);
    assert.equal(first.common_support_clusters, 6);
    assert.equal(first.bootstrap.repetitions, M12_BOOTSTRAP_REPETITIONS);
    assert.deepEqual(second, first);
    assert.equal(first.common_support_comparison.same_oos_support, true);
    assert.equal(first.common_support_comparison.same_symbols, true);
    assert.equal(first.common_support_comparison.same_timestamps, true);
    assert.equal(first.common_support_comparison.same_directions, true);
    assert.equal(first.common_support_comparison.same_events, true);
    assert.equal(first.common_support_comparison.same_evaluator_contract, true);

    const duplicatedBaseline = makeResult([0.4, -0.2], 0);
    const duplicatedAugmented = makeResult([0.45, -0.15], 0);
    duplicatedBaseline.selected_records.push({ ...duplicatedBaseline.selected_records[0], record_index: 10 });
    duplicatedAugmented.selected_records.push({ ...duplicatedAugmented.selected_records[0], record_index: 10 });
    duplicatedBaseline.oos_records = duplicatedBaseline.selected_records;
    duplicatedAugmented.oos_records = duplicatedAugmented.selected_records;
    assert.equal(compareM12Candidates(duplicatedBaseline, duplicatedAugmented).common_support_clusters, 2);
  });

  it('fails the information-gain gate when common support is below 100 clusters', () => {
    const comparison = {
      common_support_clusters: 99,
      point_estimate: { delta_net_expectancy: 1, delta_net_pf: 1 },
      bootstrap: {
        delta_expectancy_95_ci: [0.1, 1.1],
        p_delta_expectancy_gt_zero: 1,
      },
    };
    const result = evaluateInformationGainGate({
      baselineResult: {
        metrics: { false_positive_rate_percent: 50, avg_mae_percent: 1, avg_mfe_percent: 1, score_calibration: { status: 'PASS' } },
        stability: { positive_window_ratio: 0.5 },
        cluster_concentration: { max_symbol_cluster_share: 0.2, max_regime_cluster_share: 0.5, max_direction_cluster_share: 0.6, max_setup_cluster_share: 0.6 },
      },
      augmentedResult: {
        metrics: { false_positive_rate_percent: 40, avg_mae_percent: 1, avg_mfe_percent: 1, score_calibration: { status: 'PASS' } },
        stability: { positive_window_ratio: 0.6 },
        cluster_concentration: { max_symbol_cluster_share: 0.2, max_regime_cluster_share: 0.5, max_direction_cluster_share: 0.6, max_setup_cluster_share: 0.6 },
      },
      comparison,
    });
    assert.equal(result.independent_information_gain, false);
    assert.ok(result.failures.includes('common_support_independent_clusters'));
  });

  it('retains purge, embargo and chronological event isolation in the WFO plan', () => {
    const samples = Array.from({ length: 240 }, (_, index) => ({
      record_index: index,
      timestamp: START + index * HOUR,
      label_end_time: START + (index + 48) * HOUR,
      market_event_id: `event-${index}`,
      outcome: 0.1,
    }));
    const plan = buildPurgedWalkForwardPlan(samples, {
      trainSize: 100,
      testSize: 10,
      step: 10,
      purgeHours: 48,
      embargoHours: 24,
      labelHorizonHours: 48,
      finalHoldoutCount: 20,
      minimumTrainSamples: 20,
    });
    assert.ok(plan.windows.length > 0);
    assert.equal(plan.final_holdout_untouched, true);
    for (const window of plan.windows) {
      assert.ok(window.train_end < window.test_start);
      assert.ok(window.embargo_hours >= 24);
      assert.ok(window.purge_hours >= 48);
    }
  });

  it('keeps M1.2 research shadow-only and non-trading by construction', () => {
    assert.deepEqual(M12_SAFETY_FLAGS, {
      V1_UNCHANGED: true,
      V2_PRODUCTION_ENABLED: false,
      V2_SHADOW_ONLY: true,
      AUTO_TRADING: false,
      M2_STARTED: false,
    });
  });
});

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
  buildM12DerivativeEffectAudit,
  compareM12Candidates,
  evaluateInformationGainGate,
  fitM12Policy,
  predictM12Selections,
  runM12Candidate,
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

function scoredSample(index, baseScore, derivativeValue, overrides = {}) {
  const sample = attachedSample(index, {
    ...overrides,
    funding: derivativeValue,
  });
  return {
    ...sample,
    ...overrides,
    evidence_by_group: [{ group: 'Trend', strength: (baseScore - 50) / 50 }],
  };
}

function syntheticDerivativeModel({ threshold = 50, baseThreshold = 50 } = {}) {
  return {
    base_policy: {
      event_policy: { selected_window_hours: 4 },
      horizon_policy: { fallback_horizon_hours: 1 },
      score_policy: { groups: ['Trend'], weights: { Trend: 1 } },
      score_threshold: baseThreshold,
      volatility_policy: { gate_applied: false },
    },
    derivative_policy: {
      families: ['Funding'],
      policies: {
        Funding: {
          family: 'Funding',
          fitted: true,
          mean: 0,
          effective_standard_deviation: 1,
          sign: 1,
          quantile_grid: [[0, -1], [1, 1]],
        },
      },
    },
    augmented_score_threshold: threshold,
    cluster_top_n: 1,
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
  it('lets favorable and unfavorable derivatives promote, demote and reorder candidates', () => {
    const promote = predictM12Selections([
      scoredSample(0, 40, 1),
    ], syntheticDerivativeModel())[0];
    assert.equal(promote.base_eligible, false);
    assert.equal(promote.augmented_eligible, true);
    assert.equal(promote.selected, true);

    const demote = predictM12Selections([
      scoredSample(1, 60, -1),
    ], syntheticDerivativeModel())[0];
    assert.equal(demote.base_eligible, true);
    assert.equal(demote.augmented_eligible, false);
    assert.equal(demote.selected, false);

    const ranking = predictM12Selections([
      scoredSample(2, 60, 1, { symbol: 'BTCUSDT' }),
      scoredSample(2, 70, -1, { symbol: 'ETHUSDT' }),
    ], syntheticDerivativeModel({ threshold: 0, baseThreshold: 0 }));
    assert.equal(ranking.filter(item => item.selected).length, 1);
    assert.equal(ranking.find(item => item.selected).sample.symbol, 'BTCUSDT');
    assert.notEqual(ranking[0].sample.combined_score, ranking[0].sample.base_score);
  });

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

  it('fits the augmented threshold from the C0 training rate only', () => {
    const train = Array.from({ length: 60 }, (_, index) => scoredSample(
      index,
      index % 2 ? 60 : 40,
      index % 2 ? 1 : -1,
      { outcome: index % 2 ? 0.2 : -0.1 },
    ));
    const model = fitM12Policy(train, { derivative_families: ['Funding'] });
    assert.equal(model.training_eligibility.training_only, true);
    assert.match(model.training_eligibility.selection_basis, /c0_training_eligibility_rate/);
    assert.equal(
      model.training_eligibility.base_training_eligibility_rate,
      model.training_eligibility.base_training_eligible_count / model.training_eligibility.base_training_sample_count,
    );
    assert.equal(model.augmented_score_threshold, model.training_eligibility.augmented_score_threshold);

    const test = [scoredSample(100, 40, 1, { outcome: -100 })];
    predictM12Selections(test, model);
    test[0].outcome = 100;
    predictM12Selections(test, model);
    assert.equal(model.augmented_score_threshold, model.training_eligibility.augmented_score_threshold);

    const fittedAgain = fitM12Policy(train, { derivative_families: ['Funding'] });
    assert.deepEqual(fittedAgain.derivative_policy, model.derivative_policy);
    assert.equal(fittedAgain.augmented_score_threshold, model.augmented_score_threshold);
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

  it('produces a deterministic event bootstrap with abstention on common support', () => {
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
    assert.equal(first.paired_common_events, 6);
    assert.equal(first.bootstrap.unit, 'market_event_id');
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

    const sameEvent = outcome => ({
      data_source: 'public_binance_futures_archive',
      candidate: { derivative_families: [] },
      oos_records: [
        { record_index: 20, window_index: 0, timestamp: START, market_event_id: 'shared', direction: 'BUY', symbol: 'BTCUSDT', primary_outcome: outcome, primary_gross_outcome_percent: outcome + 0.14, selected: true },
        { record_index: 21, window_index: 0, timestamp: START, market_event_id: 'shared', direction: 'SELL', symbol: 'ETHUSDT', primary_outcome: outcome, primary_gross_outcome_percent: outcome + 0.14, selected: true },
      ],
      selected_records: [],
      walk_forward: { windows: [] },
    });
    const eventBaseline = sameEvent(0.4);
    eventBaseline.selected_records = eventBaseline.oos_records;
    const eventAugmented = sameEvent(0.2);
    eventAugmented.selected_records = [];
    const abstention = compareM12Candidates(eventBaseline, eventAugmented);
    assert.equal(abstention.underlying_oos_events, 1);
    assert.equal(abstention.pit_valid_common_events, 1);
    assert.equal(abstention.baseline_action_events, 1);
    assert.equal(abstention.augmented_action_events, 0);
    assert.equal(abstention.paired_common_events, 1);
    assert.equal(abstention.bootstrap.unit_count, 1);
    assert.equal(abstention.paired_event_outcomes[0].baseline_event_outcome, 0.4);
    assert.equal(abstention.paired_event_outcomes[0].augmented_event_outcome, 0);
    assert.equal(abstention.point_estimate.delta_net_expectancy, -0.4);

    const outcomeChanged = sameEvent(0.9);
    outcomeChanged.selected_records = outcomeChanged.oos_records;
    const supportChangedOnlyByOutcome = compareM12Candidates(eventBaseline, outcomeChanged);
    assert.equal(supportChangedOnlyByOutcome.underlying_oos_events, 1);
    assert.equal(supportChangedOnlyByOutcome.paired_common_events, 1);
    assert.equal(supportChangedOnlyByOutcome.common_support_comparison.same_oos_support, true);

    const validFeature = { point_in_time_valid: true, representative_value: 1 };
    const invalidFeature = { point_in_time_valid: false, representative_value: null };
    const pitBaselineRecords = ['valid-event', 'invalid-event'].map((market_event_id, index) => ({
      record_index: 30 + index,
      window_index: 0,
      timestamp: START + index * HOUR,
      market_event_id,
      direction: 'BUY',
      symbol: 'BTCUSDT',
      primary_outcome: 0.2,
      selected: true,
      derivatives: { Funding: validFeature },
    }));
    const pitAugmentedRecords = pitBaselineRecords.map(record => ({
      ...record,
      derivatives: { Funding: record.market_event_id === 'valid-event' ? validFeature : invalidFeature },
    }));
    const pitComparison = compareM12Candidates(
      { oos_records: pitBaselineRecords, selected_records: pitBaselineRecords },
      { candidate: { derivative_families: ['Funding'] }, oos_records: pitAugmentedRecords, selected_records: pitAugmentedRecords },
    );
    assert.equal(pitComparison.underlying_oos_events, 2);
    assert.equal(pitComparison.pit_valid_common_events, 1);
    assert.equal(pitComparison.paired_common_events, 1);
  });

  it('flags feature variation with no decision effect as an integration no-op', () => {
    const baselineRecords = [0, 1].map(index => ({
      record_index: index,
      window_index: 0,
      market_event_id: `event-${index}`,
      selected: true,
      base_eligible: true,
      oos_cluster_rank: 1,
      base_score: 50,
      combined_score: 50,
      derivatives: { Funding: { point_in_time_valid: true, representative_value: index + 1 } },
      derivative_scores: { Funding: 50 },
    }));
    const augmentedRecords = baselineRecords.map((record, index) => ({
      ...record,
      augmented_eligible: true,
      combined_score: index ? 60 : 40,
      derivative_scores: { Funding: index ? 70 : 30 },
    }));
    const audit = buildM12DerivativeEffectAudit(
      { oos_records: baselineRecords },
      { oos_records: augmentedRecords, candidate: { derivative_families: ['Funding'] } },
      ['Funding'],
    );
    assert.ok(audit.total.derivative_score_variance > 0);
    assert.ok(audit.total.family_score_variance.Funding > 0);
    assert.ok(audit.total.family_feature_variance.Funding > 0);
    assert.equal(audit.total.eligibility_promoted_count, 0);
    assert.equal(audit.total.eligibility_demoted_count, 0);
    assert.equal(audit.total.ranking_changed_count, 0);
    assert.equal(audit.total.selected_record_changed_count, 0);
    assert.equal(audit.integration_no_op, true);
    assert.deepEqual(audit.total.integration_no_op_families, ['Funding']);
  });

  it('keeps primary absolute metrics limited to cluster-selected OOS records', () => {
    const samples = Array.from({ length: 180 }, (_, index) => {
      const sample = scoredSample(index, 60 + (index % 4), index / 100, {
        outcome: index % 3 ? 0.2 : -0.1,
      });
      return {
        ...sample,
        gross_return_percent: sample.outcome + 0.14,
        forward_returns: { '1h': sample.outcome + 0.14 },
        net_forward_returns: { '1h': sample.outcome },
      };
    });
    const result = runM12Candidate(samples, {
      candidateId: M12_PREDECLARED_CANDIDATES[0].candidate_id,
      candidate: M12_PREDECLARED_CANDIDATES[0],
      wfoOptions: {
        trainSize: 60,
        testSize: 15,
        step: 15,
        finalHoldoutCount: 20,
        purgeHours: 48,
        embargoHours: 24,
        labelHorizonHours: 1,
        minimumTrainSamples: 30,
        minimumWindows: 6,
      },
    });
    assert.equal(result.metrics.sample_count, result.selected_records.length);
    assert.equal(result.metrics.selected_oos_signals, result.selected_records.length);
    assert.ok(result.all_oos_metrics.sample_count >= result.metrics.sample_count);
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

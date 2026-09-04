// Bounded M1.2 comparison of the frozen candle-only baseline with public,
// point-in-time derivatives information. This module is research-only.

import { hashConfig } from '../lineage.js';
import { buildScoreCalibration } from './scoring.js';
import {
  M1_FROZEN_HOLDOUT,
  applyEventPolicy,
  applyHorizonPolicy,
  fitM11Policy,
  rankM11Selections,
  runM11Candidate,
  scoreWithPolicy,
  sampleTimestamp,
  primaryNet,
  primaryGross,
} from './edgeDiscovery.js';
import {
  M12_DERIVATIVE_FAMILIES,
  M12_FEATURE_VERSION,
  applyDerivativePolicies,
  fitDerivativePolicies,
} from './microstructureFeatures.js';

export const M12_MODEL_VERSION = 'm1.2-v2-independent-information-gain-0.1.0';
export const M12_CANDIDATE_BUDGET = 16;
export const M12_BOOTSTRAP_REPETITIONS = 2000;
export const M12_BOOTSTRAP_SEED = 20260904;
export const M12_SAFETY_FLAGS = Object.freeze({
  V1_UNCHANGED: true,
  V2_PRODUCTION_ENABLED: false,
  V2_SHADOW_ONLY: true,
  AUTO_TRADING: false,
  M2_STARTED: false,
});

export const M12_BASELINE_CANDIDATE = Object.freeze({
  candidate_id: 'A-equal-weight-train-event-top1',
  score_method: 'equal_weight',
  event_policy: 'train_select',
  cluster_top_n: 1,
  horizon_policy: 'train_selected_per_setup',
});

export const M12_PREDECLARED_CANDIDATES = Object.freeze([
  {
    candidate_id: 'C0-candle-only-frozen-m1.1-baseline',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: [],
  },
  {
    candidate_id: 'C1-baseline-plus-funding',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Funding'],
  },
  {
    candidate_id: 'C2-baseline-plus-open-interest',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Open Interest'],
  },
  {
    candidate_id: 'C3-baseline-plus-basis-premium',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Basis/Premium'],
  },
  {
    candidate_id: 'C4-baseline-plus-taker-flow',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Taker Flow'],
  },
  {
    candidate_id: 'C5-funding-plus-open-interest',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Funding', 'Open Interest'],
  },
  {
    candidate_id: 'C6-open-interest-plus-taker-flow',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Open Interest', 'Taker Flow'],
  },
  {
    candidate_id: 'C7-funding-plus-basis-premium',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Funding', 'Basis/Premium'],
  },
  {
    candidate_id: 'C8-funding-plus-open-interest-plus-taker-flow',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: ['Funding', 'Open Interest', 'Taker Flow'],
  },
  {
    candidate_id: 'C9-all-admitted-independent-families',
    base_candidate: M12_BASELINE_CANDIDATE,
    derivative_families: [...M12_DERIVATIVE_FAMILIES],
  },
]);

function finite(value) {
  return value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function profitFactor(values) {
  const wins = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return losses ? wins / losses : wins > 0 ? 999 : 0;
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper
    ? sorted[lower]
    : sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function direction(record) {
  return String(record?.direction ?? record?.signal ?? '').toUpperCase() || 'UNKNOWN';
}

function selectedClusterKey(record) {
  if (!record?.market_event_id) return null;
  return `${record.window_index ?? 'NA'}|${record.market_event_id}|${direction(record)}`;
}

function clusterOutcomes(records = []) {
  const clusters = new Map();
  for (const record of records) {
    const key = selectedClusterKey(record);
    const net = primaryNet(record);
    if (!key || net === null) continue;
    if (!clusters.has(key)) clusters.set(key, []);
    clusters.get(key).push({
      record,
      net,
      gross: primaryGross(record),
    });
  }
  return new Map([...clusters.entries()].map(([key, members]) => {
    const sorted = [...members].sort((left, right) => (
      (left.record.oos_cluster_rank ?? 0) - (right.record.oos_cluster_rank ?? 0)
      || String(left.record.symbol || '').localeCompare(String(right.record.symbol || ''))
    ));
    return [key, {
      cluster_id: key,
      net: average(members.map(member => member.net)),
      gross: average(members.map(member => member.gross).filter(value => value !== null)),
      representative: sorted[0].record,
    }];
  }));
}

function commonRecordSupport(left = [], right = []) {
  const key = record => `${record.window_index ?? 'NA'}|${record.record_index ?? record.timestamp ?? 'NA'}`;
  const leftKeys = new Set(left.map(key));
  const rightKeys = new Set(right.map(key));
  return {
    left_count: leftKeys.size,
    right_count: rightKeys.size,
    intersection_count: [...leftKeys].filter(value => rightKeys.has(value)).length,
    exact: leftKeys.size === rightKeys.size && [...leftKeys].every(value => rightKeys.has(value)),
  };
}

function sameRecordDimension(left = [], right = [], field) {
  const key = record => `${record.window_index ?? 'NA'}|${record.record_index ?? record.timestamp ?? 'NA'}`;
  const leftValues = new Map(left.map(record => [key(record), record[field] ?? null]));
  const rightValues = new Map(right.map(record => [key(record), record[field] ?? null]));
  if (leftValues.size !== rightValues.size) return false;
  return [...leftValues.entries()].every(([recordKey, value]) => rightValues.get(recordKey) === value);
}

function sameWindows(left = {}, right = {}) {
  const project = result => (result.walk_forward?.windows || []).map(window => ({
    index: window.index,
    train_start: window.train_start,
    train_end: window.train_end,
    test_start: window.test_start,
    test_end: window.test_end,
  }));
  return JSON.stringify(project(left)) === JSON.stringify(project(right));
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function bootstrapMetrics(pairs, repetitions, seed) {
  const random = seededRandom(seed);
  const meanDeltas = [];
  const pfDeltas = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const draw = Array.from({ length: pairs.length }, () => pairs[Math.floor(random() * pairs.length)]);
    const baseline = draw.map(pair => pair.baseline_net);
    const augmented = draw.map(pair => pair.augmented_net);
    meanDeltas.push(average(draw.map(pair => pair.delta_net)));
    pfDeltas.push(profitFactor(augmented) - profitFactor(baseline));
  }
  return {
    repetitions,
    seed,
    delta_expectancy_95_ci: [round(quantile(meanDeltas, 0.025)), round(quantile(meanDeltas, 0.975))],
    delta_net_pf_95_ci: [round(quantile(pfDeltas, 0.025), 4), round(quantile(pfDeltas, 0.975), 4)],
    p_delta_expectancy_gt_zero: round(meanDeltas.filter(value => value > 0).length / repetitions, 6),
    mean_delta_expectancy: round(average(meanDeltas)),
  };
}

/** Cluster-level paired comparison; clusters, not individual symbol rows, are resampled. */
export function compareM12Candidates(baselineResult, augmentedResult, {
  repetitions = M12_BOOTSTRAP_REPETITIONS,
  seed = M12_BOOTSTRAP_SEED,
} = {}) {
  const baselineClusters = clusterOutcomes(baselineResult?.selected_records || []);
  const augmentedClusters = clusterOutcomes(augmentedResult?.selected_records || []);
  const commonIds = [...baselineClusters.keys()]
    .filter(clusterId => augmentedClusters.has(clusterId))
    .sort();
  const pairs = commonIds.map(clusterId => ({
    cluster_id: clusterId,
    baseline_net: baselineClusters.get(clusterId).net,
    augmented_net: augmentedClusters.get(clusterId).net,
    baseline_gross: baselineClusters.get(clusterId).gross,
    augmented_gross: augmentedClusters.get(clusterId).gross,
    delta_net: augmentedClusters.get(clusterId).net - baselineClusters.get(clusterId).net,
  }));
  const baselineValues = pairs.map(pair => pair.baseline_net);
  const augmentedValues = pairs.map(pair => pair.augmented_net);
  const baselineGrossValues = pairs.map(pair => pair.baseline_gross).filter(value => value !== null);
  const augmentedGrossValues = pairs.map(pair => pair.augmented_gross).filter(value => value !== null);
  const point = {
    baseline_net_expectancy: round(average(baselineValues)),
    augmented_net_expectancy: round(average(augmentedValues)),
    delta_net_expectancy: round(average(pairs.map(pair => pair.delta_net))),
    baseline_net_pf: baselineValues.length ? round(profitFactor(baselineValues), 4) : null,
    augmented_net_pf: augmentedValues.length ? round(profitFactor(augmentedValues), 4) : null,
    delta_net_pf: baselineValues.length && augmentedValues.length
      ? round(profitFactor(augmentedValues) - profitFactor(baselineValues), 4)
      : null,
    baseline_gross_expectancy: baselineGrossValues.length ? round(average(baselineGrossValues)) : null,
    augmented_gross_expectancy: augmentedGrossValues.length ? round(average(augmentedGrossValues)) : null,
    delta_gross_expectancy: baselineGrossValues.length && augmentedGrossValues.length
      ? round(average(augmentedGrossValues) - average(baselineGrossValues))
      : null,
    delta_hit_rate: baselineValues.length && augmentedValues.length
      ? round(augmentedValues.filter(value => value > 0).length / augmentedValues.length
        - baselineValues.filter(value => value > 0).length / baselineValues.length, 6)
      : null,
  };
  const exactOosRecordSupport = commonRecordSupport(
    baselineResult?.oos_records || [],
    augmentedResult?.oos_records || [],
  );
  const sameOosWindows = sameWindows(baselineResult, augmentedResult);
  const sameSymbols = sameRecordDimension(
    baselineResult?.oos_records || [],
    augmentedResult?.oos_records || [],
    'symbol',
  );
  const sameTimestamps = sameRecordDimension(
    baselineResult?.oos_records || [],
    augmentedResult?.oos_records || [],
    'timestamp',
  );
  const sameDirections = sameRecordDimension(
    baselineResult?.oos_records || [],
    augmentedResult?.oos_records || [],
    'direction',
  );
  const sameEvents = sameRecordDimension(
    baselineResult?.oos_records || [],
    augmentedResult?.oos_records || [],
    'market_event_id',
  );
  const sameEvaluatorContract = baselineResult?.data_source === augmentedResult?.data_source
    && JSON.stringify(baselineResult?.walk_forward?.options || {})
      === JSON.stringify(augmentedResult?.walk_forward?.options || {});
  const bootstrap = pairs.length >= 1
    ? bootstrapMetrics(pairs, repetitions, seed)
    : {
      repetitions: 0,
      requested_repetitions: repetitions,
      seed,
      delta_expectancy_95_ci: [null, null],
      delta_net_pf_95_ci: [null, null],
      p_delta_expectancy_gt_zero: null,
      mean_delta_expectancy: null,
    };
  return {
    common_support_clusters: pairs.length,
    baseline_selected_clusters: baselineClusters.size,
    augmented_selected_clusters: augmentedClusters.size,
    paired_cluster_ids: commonIds,
    common_support_comparison: {
      unit: 'window|market_event_id|direction',
      same_oos_windows: sameOosWindows,
      exact_oos_record_support: exactOosRecordSupport,
      same_symbols: sameSymbols,
      same_timestamps: sameTimestamps,
      same_directions: sameDirections,
      same_events: sameEvents,
      same_evaluator_contract: sameEvaluatorContract,
      same_oos_support: sameOosWindows
        && exactOosRecordSupport.exact
        && sameSymbols
        && sameTimestamps
        && sameDirections
        && sameEvents
        && sameEvaluatorContract,
    },
    point_estimate: point,
    bootstrap,
  };
}

function clusterAttributes(records = []) {
  const clusters = new Map();
  for (const record of records) {
    const id = record.market_event_id;
    if (!id || !record.selected) continue;
    if (!clusters.has(id)) clusters.set(id, []);
    clusters.get(id).push(record);
  }
  const representatives = [...clusters.values()].map(members => [...members].sort((left, right) => (
    (left.oos_cluster_rank ?? 0) - (right.oos_cluster_rank ?? 0)
    || String(left.symbol || '').localeCompare(String(right.symbol || ''))
  ))[0]);
  const shares = field => {
    const counts = {};
    for (const record of representatives) {
      const value = record[field] || 'UNKNOWN';
      counts[value] = (counts[value] || 0) + 1;
    }
    const total = representatives.length;
    const ordered = Object.entries(counts).sort((left, right) => right[1] - left[1]);
    return {
      counts: Object.fromEntries(ordered),
      max_share: total ? round((ordered[0]?.[1] || 0) / total, 6) : 0,
      max_key: ordered[0]?.[0] || null,
    };
  };
  const recordCounts = field => {
    const counts = {};
    for (const record of records.filter(item => item.selected)) {
      const value = record[field] || 'UNKNOWN';
      counts[value] = (counts[value] || 0) + 1;
    }
    return counts;
  };
  return {
    independent_cluster_count: representatives.length,
    symbol: shares('symbol'),
    regime: shares('trend_regime'),
    direction: shares('direction'),
    setup: shares('setup_family'),
    max_symbol_cluster_share: shares('symbol').max_share,
    max_regime_cluster_share: shares('trend_regime').max_share,
    max_direction_cluster_share: shares('direction').max_share,
    max_setup_cluster_share: shares('setup_family').max_share,
    record_level: {
      symbol: recordCounts('symbol'),
      regime: recordCounts('trend_regime'),
      direction: recordCounts('direction'),
      setup: recordCounts('setup_family'),
      selected_records: records.filter(record => record.selected).length,
    },
  };
}

export function calculateM12ClusterConcentration(records = []) {
  return clusterAttributes(records);
}

function calibrationImproved(baseline, augmented) {
  if (baseline?.status === 'PASS') return augmented?.status === 'PASS';
  return augmented?.monotonic_oos_expectancy === true
    && augmented?.sample_count >= baseline?.sample_count;
}

function concentrationSevere(baseline, augmented) {
  const fields = [
    'max_symbol_cluster_share',
    'max_regime_cluster_share',
    'max_direction_cluster_share',
    'max_setup_cluster_share',
  ];
  return fields.some(field => (
    (augmented?.[field] ?? 0) > 0.7
    || (augmented?.[field] ?? 0) > (baseline?.[field] ?? 0) + 0.2
  ));
}

export function evaluateInformationGainGate({
  baselineResult,
  augmentedResult,
  comparison,
} = {}) {
  const baselineMetrics = baselineResult?.metrics || {};
  const augmentedMetrics = augmentedResult?.metrics || {};
  const baselineStability = baselineResult?.stability || {};
  const augmentedStability = augmentedResult?.stability || {};
  const baselineConcentration = baselineResult?.cluster_concentration || calculateM12ClusterConcentration(baselineResult?.selected_records || []);
  const augmentedConcentration = augmentedResult?.cluster_concentration || calculateM12ClusterConcentration(augmentedResult?.selected_records || []);
  const ciLower = comparison?.bootstrap?.delta_expectancy_95_ci?.[0] ?? null;
  const pPositive = comparison?.bootstrap?.p_delta_expectancy_gt_zero ?? null;
  const observed = {
    common_support_independent_clusters: comparison?.common_support_clusters || 0,
    delta_net_expectancy: comparison?.point_estimate?.delta_net_expectancy ?? null,
    delta_net_profit_factor: comparison?.point_estimate?.delta_net_pf ?? null,
    delta_hit_rate: comparison?.point_estimate?.delta_hit_rate ?? null,
    delta_false_positive_rate: augmentedMetrics.false_positive_rate_percent === null
      || baselineMetrics.false_positive_rate_percent === null
      ? null
      : round(augmentedMetrics.false_positive_rate_percent - baselineMetrics.false_positive_rate_percent),
    delta_mae: augmentedMetrics.avg_mae_percent === null || baselineMetrics.avg_mae_percent === null
      ? null
      : round(augmentedMetrics.avg_mae_percent - baselineMetrics.avg_mae_percent),
    delta_mfe: augmentedMetrics.avg_mfe_percent === null || baselineMetrics.avg_mfe_percent === null
      ? null
      : round(augmentedMetrics.avg_mfe_percent - baselineMetrics.avg_mfe_percent),
    baseline_positive_window_ratio: baselineStability.positive_window_ratio ?? 0,
    augmented_positive_window_ratio: augmentedStability.positive_window_ratio ?? 0,
    concentration_severe: concentrationSevere(baselineConcentration, augmentedConcentration),
    calibration_ordering_improved: calibrationImproved(
      baselineMetrics.score_calibration,
      augmentedMetrics.score_calibration,
    ),
  };
  const failures = [];
  if (observed.common_support_independent_clusters < 100) failures.push('common_support_independent_clusters');
  if (!(observed.delta_net_expectancy > 0)) failures.push('delta_net_expectancy_not_positive');
  if (!(ciLower !== null && ciLower >= 0)) failures.push('delta_expectancy_ci_lower_bound');
  if (!(pPositive !== null && pPositive >= 0.95)) failures.push('p_delta_expectancy_gt_zero');
  if (observed.augmented_positive_window_ratio < observed.baseline_positive_window_ratio) {
    failures.push('positive_window_ratio');
  }
  if (observed.concentration_severe) failures.push('severe_concentration_deterioration');
  if (!observed.calibration_ordering_improved) failures.push('calibration_ordering');
  return {
    independent_information_gain: failures.length === 0,
    thresholds: {
      common_support_independent_clusters: 100,
      delta_net_expectancy: '> 0',
      delta_expectancy_ci_lower_bound: '>= 0',
      p_delta_expectancy_gt_zero: '>= 0.95',
      augmented_positive_window_ratio: '>= baseline',
      severe_concentration_deterioration: false,
      calibration_ordering: 'no PASS to FAIL; measurable ordering improvement if baseline FAIL',
    },
    observed,
    failures,
  };
}

function evaluateAbsolutePromotionGate(result) {
  const metrics = result?.metrics || {};
  const stability = result?.stability || {};
  const failures = [];
  const observed = {
    independent_clusters: result?.cluster_concentration?.independent_cluster_count || 0,
    net_profit_factor: metrics.net_profit_factor ?? 0,
    net_expectancy_percent: metrics.net_expectancy_percent ?? 0,
    oos_windows: stability.total_windows || 0,
    positive_windows: stability.positive_windows || 0,
    positive_window_ratio: stability.positive_window_ratio || 0,
    symbol_breadth: metrics.symbol_breadth || 0,
    calibration: metrics.score_calibration?.status || 'CALIBRATION_FAIL',
  };
  if (observed.independent_clusters < 100) failures.push('independent_clusters');
  if (observed.net_profit_factor < 1.25) failures.push('net_profit_factor');
  if (observed.net_expectancy_percent < 0.15) failures.push('net_expectancy_percent');
  if (observed.oos_windows < 6) failures.push('oos_windows');
  if (observed.positive_windows < 4) failures.push('positive_windows');
  if (observed.positive_window_ratio < 2 / 3) failures.push('positive_window_ratio');
  if (observed.symbol_breadth < 8) failures.push('symbol_breadth');
  if (observed.calibration !== 'PASS') failures.push('calibration');
  return {
    pass: failures.length === 0,
    thresholds: {
      independent_clusters: 100,
      net_profit_factor: 1.25,
      net_expectancy_percent: 0.15,
      oos_windows: 6,
      positive_windows: 4,
      positive_window_ratio: 2 / 3,
      symbol_breadth: 8,
      calibration: 'PASS',
    },
    observed,
    failures,
  };
}

export function fitM12Policy(trainSamples = [], candidate = {}) {
  const basePolicy = fitM11Policy(trainSamples, {
    ...M12_BASELINE_CANDIDATE,
    ...(candidate.base_candidate || {}),
  });
  const primaryTrain = applyHorizonPolicy(
    applyEventPolicy(trainSamples, basePolicy.event_policy.selected_window_hours),
    basePolicy.horizon_policy,
  );
  const derivativePolicy = fitDerivativePolicies(
    primaryTrain,
    candidate.derivative_families || [],
    { minimumSamples: candidate.minimum_derivative_samples ?? 30 },
  );
  return {
    version: M12_MODEL_VERSION,
    feature_version: M12_FEATURE_VERSION,
    training_only: true,
    frozen_candle_baseline: M12_BASELINE_CANDIDATE.candidate_id,
    base_policy: basePolicy,
    derivative_policy: derivativePolicy,
    derivative_families: derivativePolicy.families,
    score_threshold: basePolicy.score_threshold,
    cluster_top_n: basePolicy.cluster_top_n,
    summary: {
      base_score_method: basePolicy.score_policy.score_method,
      base_event_policy: basePolicy.event_policy,
      base_horizon_policy: basePolicy.horizon_policy,
      base_volatility_policy: basePolicy.volatility_policy,
      derivative_families: derivativePolicy.families,
      derivative_policy: derivativePolicy,
      score_threshold: basePolicy.score_threshold,
      ranking_score_not_probability: true,
      training_only: true,
    },
  };
}

export function predictM12Selections(testSamples = [], model = {}) {
  const basePolicy = model.base_policy || {};
  const eventSamples = applyEventPolicy(
    testSamples,
    basePolicy.event_policy?.selected_window_hours ?? 4,
  );
  const horizonSamples = applyHorizonPolicy(eventSamples, basePolicy.horizon_policy || {});
  const derivativeFamilies = model.derivative_policy?.families || [];
  const threshold = finite(basePolicy.score_threshold);
  const volatilityPolicy = basePolicy.volatility_policy || {};
  const gatedRegimes = new Set(volatilityPolicy.selected_regimes || []);
  const predictions = horizonSamples.map((sample, index) => {
    const baseScore = scoreWithPolicy(sample, basePolicy.score_policy);
    const derivative = applyDerivativePolicies(sample, model.derivative_policy || {});
    const derivativeScores = Object.values(derivative.scores);
    const combinedScore = derivativeScores.length
      ? (baseScore + derivativeScores.reduce((sum, value) => sum + value, 0)) / (derivativeScores.length + 1)
      : baseScore;
    const scoreThresholdEligible = threshold === null || baseScore >= threshold;
    const volatilityEligible = !volatilityPolicy.gate_applied
      || gatedRegimes.has(sample.volatility_regime);
    const derivativeEligible = derivative.all_valid;
    const eligible = scoreThresholdEligible && volatilityEligible && derivativeEligible;
    return {
      sample: {
        ...sample,
        learned_score: round(combinedScore, 8),
        empirical_score: round(combinedScore, 8),
        base_learned_score: round(baseScore, 8),
        derivative_scores: derivative.scores,
        derivative_normalized_features: derivative.normalized,
        derivative_invalid_families: derivative.invalid_families,
      },
      sample_index: index,
      raw_score_eligible: threshold === null || baseScore >= threshold,
      score_threshold_eligible: scoreThresholdEligible,
      score_eligible: eligible,
      volatility_eligible: volatilityEligible,
      derivative_eligible: derivativeEligible,
      eligible,
      selected: false,
      cluster_selected: false,
      selection_status: !derivativeEligible
        ? 'DERIVATIVE_DATA_INVALID'
        : eligible ? 'SCORE_ELIGIBLE_NOT_SELECTED' : 'SCORE_INELIGIBLE',
      oos_cluster_rank: null,
      oos_ranking_bucket: eligible ? 'WATCH' : 'SHADOW',
    };
  });
  return rankM11Selections(predictions, model.cluster_top_n ?? 1);
}

export function runM12Candidate(samples = [], {
  candidateId = 'candidate',
  candidate = {},
  dataSource = 'public_binance_futures_archive',
  wfoOptions = {},
} = {}) {
  const result = runM11Candidate(samples, {
    candidateId,
    candidate,
    dataSource,
    wfoOptions,
    fitPolicy: fitM12Policy,
    predictPolicy: predictM12Selections,
    modelVersion: M12_MODEL_VERSION,
  });
  result.cluster_concentration = calculateM12ClusterConcentration(result.selected_records);
  result.absolute_promotion = evaluateAbsolutePromotionGate(result);
  result.config_hash = hashConfig({
    model_version: M12_MODEL_VERSION,
    candidate,
    frozen_candle_baseline: M12_BASELINE_CANDIDATE,
    wfo_options: result.walk_forward.options,
  });
  return result;
}

export function summarizeM12Candidate(result, {
  baselineResult = null,
  admittedFamilies = M12_DERIVATIVE_FAMILIES,
} = {}) {
  const families = result.candidate?.derivative_families || [];
  const rejectedFamilies = families.filter(family => !admittedFamilies.includes(family));
  if (rejectedFamilies.length) {
    return {
      candidate_id: result.candidate_id,
      model_version: M12_MODEL_VERSION,
      derivative_families: families,
      status: 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY',
      rejected_families: rejectedFamilies,
      independent_information_gain: false,
      absolute_promotion: null,
    };
  }
  const comparison = baselineResult && result !== baselineResult
    ? compareM12Candidates(baselineResult, result)
    : null;
  const informationGain = comparison
    ? evaluateInformationGainGate({
      baselineResult,
      augmentedResult: result,
      comparison,
    })
    : null;
  return {
    candidate_id: result.candidate_id,
    config_hash: result.config_hash,
    model_version: M12_MODEL_VERSION,
    feature_version: M12_FEATURE_VERSION,
    derivative_families: families,
    status: 'EVALUATED',
    selected_oos_signals: result.metrics?.selected_oos_signals ?? 0,
    independent_oos_clusters: result.cluster_concentration?.independent_cluster_count ?? 0,
    net_profit_factor: result.metrics?.net_profit_factor ?? null,
    gross_profit_factor: result.metrics?.gross_profit_factor ?? null,
    net_expectancy_percent: result.metrics?.net_expectancy_percent ?? null,
    gross_expectancy_percent: result.metrics?.gross_expectancy_percent ?? null,
    hit_rate_percent: result.metrics?.hit_rate_percent ?? null,
    false_positive_rate_percent: result.metrics?.false_positive_rate_percent ?? null,
    avg_mfe_percent: result.metrics?.avg_mfe_percent ?? null,
    avg_mae_percent: result.metrics?.avg_mae_percent ?? null,
    positive_windows: result.stability?.positive_windows ?? 0,
    total_windows: result.stability?.total_windows ?? 0,
    positive_window_ratio: result.stability?.positive_window_ratio ?? 0,
    calibration: result.metrics?.score_calibration?.status || 'CALIBRATION_FAIL',
    concentration: result.cluster_concentration,
    absolute_promotion: result.absolute_promotion,
    comparison,
    information_gain: informationGain,
    independent_information_gain: informationGain?.independent_information_gain === true,
  };
}

export function buildM12FeatureFamilyAblation(candidateSummaries = []) {
  return Object.fromEntries(M12_DERIVATIVE_FAMILIES.map(family => {
    const candidates = candidateSummaries.filter(summary => summary.derivative_families?.includes(family));
    const best = [...candidates].sort((left, right) => (
      (right.information_gain?.observed?.delta_net_expectancy ?? -Infinity)
      - (left.information_gain?.observed?.delta_net_expectancy ?? -Infinity)
    ))[0] || null;
    return [family, {
      family,
      candidate_ids: candidates.map(summary => summary.candidate_id),
      best_candidate_id: best?.candidate_id || null,
      independent_information_gain: candidates.some(summary => summary.independent_information_gain),
      best_comparison: best?.comparison || null,
    }];
  }));
}

export function decideM12({
  baselineSummary,
  candidateSummaries = [],
} = {}) {
  const gain = candidateSummaries.find(summary => summary.independent_information_gain === true);
  if (gain?.absolute_promotion?.pass) return 'SHADOW_CANDIDATE';
  if (gain) return 'INFORMATION_GAIN_BUT_NOT_PROMOTABLE';
  const evaluated = candidateSummaries.filter(summary => summary.status === 'EVALUATED');
  return evaluated.length ? 'NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN' : 'INSUFFICIENT_DERIVATIVES_DATA';
}

export function m12CandidateConfigHash({
  candidate,
  featureVersion = M12_FEATURE_VERSION,
  dataAdmission,
  wfoOptions,
  roundTripCostPercent = 0.14,
  generationHistoryCandles = 256,
  holdout = M1_FROZEN_HOLDOUT,
} = {}) {
  return hashConfig({
    model_version: M12_MODEL_VERSION,
    feature_version: featureVersion,
    frozen_candle_baseline: M12_BASELINE_CANDIDATE,
    candidate,
    data_admission_policy: dataAdmission,
    wfo: wfoOptions,
    round_trip_cost_percent: roundTripCostPercent,
    generation_history_candles: generationHistoryCandles,
    holdout,
  });
}

export { buildScoreCalibration };

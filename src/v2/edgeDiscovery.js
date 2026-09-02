// Bounded M1.1 edge-discovery protocol. This module consumes compact,
// already-evaluated historical records and never touches production paths.

import { hashConfig } from '../lineage.js';
import { buildScoreCalibration } from './scoring.js';
import { marketEventId } from './marketEvents.js';
import {
  runPurgedWalkForward,
  selectTrainingVolatilityPolicy,
} from './walkForward.js';

const HOUR = 60 * 60 * 1000;

export const M11_MODEL_VERSION = 'm1.1-v2-edge-0.1.0';
export const M11_HORIZONS_HOURS = Object.freeze([1, 4, 8, 12, 24, 48]);
export const M11_SETUP_FAMILIES = Object.freeze([
  'Trend Continuation',
  'Mean Reversion',
  'Breakout',
]);
export const M11_EVIDENCE_GROUPS = Object.freeze([
  'Trend',
  'Momentum',
  'Participation',
  'Volatility',
  'Market Structure',
  'Higher Timeframe',
]);
export const M11_EVENT_WINDOWS_HOURS = Object.freeze([1, 4]);
export const M11_CANDIDATE_BUDGET = 20;

// This is boundary metadata from the accepted M1 artifact. It is deliberately
// kept separate from the M1 performance numbers and is never used as a label.
export const M1_FROZEN_HOLDOUT = Object.freeze({
  boundary_timestamp: 1787245199999,
  final_holdout_hash: '6a25ed58059cbd5cced28b69ff85c59f8e177a84e7724605853730630595b7fe',
});

// Historical comparator metadata only. M1.1 never uses these values to fit a
// policy or choose a candidate.
export const M1_BASELINE = Object.freeze({
  model_version: 'm1-v2-quality-0.1.0',
  selected_oos_signals: 261,
  independent_oos_clusters: 164,
  net_profit_factor: 0.4533,
  net_expectancy_percent: -0.202178,
  oos_windows: 10,
  positive_windows: 1,
  calibration: 'CALIBRATION_FAIL',
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function round(value, digits = 6) {
  return Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function profitFactor(values) {
  const wins = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return losses ? wins / losses : wins > 0 ? 999 : 0;
}

function sampleTimestamp(sample) {
  const value = sample?.timestamp
    ?? sample?.trigger_time
    ?? sample?.signal_timestamp
    ?? sample?.time;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function sampleRecordIndex(sample, fallback = null) {
  const value = finite(sample?.record_index);
  return value === null ? fallback : value;
}

function direction(sample) {
  return String(sample?.direction ?? sample?.signal ?? '').toUpperCase() || 'UNKNOWN';
}

function outcomeKey(horizonHours) {
  return `${horizonHours}h`;
}

function netOutcome(sample, horizonHours) {
  const key = outcomeKey(horizonHours);
  return finite(sample?.net_forward_returns?.[key])
    ?? (horizonHours === 1 ? finite(sample?.outcome) : null)
    ?? finite(sample?.net_return_percent);
}

function grossOutcome(sample, horizonHours) {
  const key = outcomeKey(horizonHours);
  return finite(sample?.forward_returns?.[key])
    ?? (horizonHours === 1 ? finite(sample?.gross_return_percent) : null);
}

function evidenceMap(sample) {
  const strongest = new Map();
  for (const entry of sample?.evidence_by_group || []) {
    const group = entry?.group;
    if (!M11_EVIDENCE_GROUPS.includes(group)) continue;
    const strength = finite(entry.strength);
    if (strength === null) continue;
    const current = strongest.get(group);
    if (!current || Math.abs(strength) > Math.abs(current)) strongest.set(group, strength);
  }
  return strongest;
}

function eventBucket(timestamp, windowHours) {
  return Math.floor(timestamp / (windowHours * HOUR)) * windowHours * HOUR;
}

/** Assign a point-in-time event definition without inspecting any outcome. */
export function applyEventPolicy(samples = [], windowHours = 4) {
  const hours = Number(windowHours);
  if (!M11_EVENT_WINDOWS_HOURS.includes(hours)) throw new Error(`Unsupported M1.1 event window: ${windowHours}`);
  const eventWindowMs = hours * HOUR;
  return samples.map((sample, index) => {
    const timestamp = sampleTimestamp(sample);
    const bucket = timestamp === null ? `unknown-${index}` : eventBucket(timestamp, hours);
    return {
      ...sample,
      market_event_id: marketEventId(bucket, { eventWindowMs }),
      event_window_hours: hours,
    };
  });
}

function trainStability(values, bucketCount = 3) {
  const ordered = values
    .filter(item => Number.isFinite(item.timestamp) && Number.isFinite(item.outcome))
    .sort((left, right) => left.timestamp - right.timestamp);
  if (!ordered.length) return { populated_buckets: 0, positive_buckets: 0, positive_ratio: null };
  const buckets = [];
  for (let index = 0; index < bucketCount; index += 1) {
    const start = Math.floor(index * ordered.length / bucketCount);
    const end = Math.floor((index + 1) * ordered.length / bucketCount);
    const bucket = ordered.slice(start, end);
    if (bucket.length) buckets.push(average(bucket.map(item => item.outcome)));
  }
  return {
    populated_buckets: buckets.length,
    positive_buckets: buckets.filter(value => value > 0).length,
    positive_ratio: buckets.length ? buckets.filter(value => value > 0).length / buckets.length : null,
  };
}

function horizonMetric(samples, horizonHours) {
  const values = samples.map(sample => ({
    timestamp: sampleTimestamp(sample),
    outcome: netOutcome(sample, horizonHours),
  })).filter(item => item.timestamp !== null && item.outcome !== null);
  const outcomes = values.map(item => item.outcome);
  const clusters = new Set(samples
    .filter(sample => netOutcome(sample, horizonHours) !== null)
    .map(sample => sample.market_event_id)
    .filter(Boolean));
  const expectancy = average(outcomes);
  const pf = profitFactor(outcomes);
  const sampleWeight = Math.min(1, outcomes.length / 100);
  const stability = trainStability(values);
  return {
    horizon_hours: horizonHours,
    sample_count: outcomes.length,
    independent_clusters: clusters.size,
    net_expectancy_percent: round(expectancy),
    net_profit_factor: round(pf, 4),
    positive_rate_percent: outcomes.length ? round(outcomes.filter(value => value > 0).length / outcomes.length * 100, 4) : null,
    stability,
    eligible: outcomes.length >= 30 && clusters.size >= 10,
    selection_score: expectancy === null
      ? null
      : round(expectancy * sampleWeight + Math.min(pf, 5) * 0.01 + (stability.positive_ratio || 0) * 0.01, 8),
  };
}

/** Fit setup-specific primary horizons from one training window only. */
export function fitHorizonPolicy(trainSamples = [], {
  horizons = M11_HORIZONS_HOURS,
  setupFamilies = M11_SETUP_FAMILIES,
  minimumSamples = 30,
  minimumIndependentClusters = 10,
  fallbackHorizon = 4,
} = {}) {
  const selectedBySetup = {};
  const perSetup = {};
  for (const setupFamily of setupFamilies) {
    const setupSamples = trainSamples.filter(sample => sample.setup_family === setupFamily);
    const metrics = horizons.map(horizon => horizonMetric(setupSamples, horizon));
    const eligible = metrics.filter(metric => (
      metric.sample_count >= minimumSamples
      && metric.independent_clusters >= minimumIndependentClusters
    ));
    const selected = [...eligible].sort((left, right) => (
      (right.selection_score ?? -Infinity) - (left.selection_score ?? -Infinity)
      || left.horizon_hours - right.horizon_hours
    ))[0];
    const selectedHorizon = selected?.horizon_hours ?? fallbackHorizon;
    selectedBySetup[setupFamily] = selectedHorizon;
    perSetup[setupFamily] = {
      selected_horizon_hours: selectedHorizon,
      fallback_used: !selected,
      minimum_samples: minimumSamples,
      minimum_independent_clusters: minimumIndependentClusters,
      horizons: metrics,
    };
  }
  return {
    version: 'm1.1-train-horizon-policy-0.1.0',
    training_only: true,
    fallback_horizon_hours: fallbackHorizon,
    selected_by_setup: selectedBySetup,
    per_setup: perSetup,
  };
}

/** Apply a frozen horizon policy; this function does not fit or inspect labels. */
export function applyHorizonPolicy(samples = [], policy = {}) {
  return samples.map(sample => {
    const horizon = Number(policy.selected_by_setup?.[sample.setup_family] ?? policy.fallback_horizon_hours ?? 4);
    return {
      ...sample,
      primary_horizon_hours: horizon,
      primary_outcome: netOutcome(sample, horizon),
      primary_gross_outcome_percent: grossOutcome(sample, horizon),
      // runPurgedWalkForward's generic scorer reads `outcome`. It is set only
      // on the train/test copy after the horizon policy has been frozen.
      outcome: netOutcome(sample, horizon),
      gross_return_percent: grossOutcome(sample, horizon),
    };
  });
}

/** Fit the existing volatility selector against the frozen primary outcome. */
export function fitM11VolatilityPolicy(trainSamples = [], options = {}) {
  const samples = Array.isArray(trainSamples) ? trainSamples : [];
  const decorated = samples.map(sample => ({
    ...sample,
    outcome: finite(sample.primary_outcome),
  }));
  const policy = selectTrainingVolatilityPolicy(decorated, {
    minimumSamplesPerRegime: options.minimumSamplesPerRegime ?? 20,
    minimumRegimes: options.minimumRegimes ?? 2,
    minimumImprovementPercent: options.minimumImprovementPercent ?? 0,
  });
  return {
    ...policy,
    version: 'm1.1-training-volatility-policy-0.1.0',
    selection_basis: 'training_primary_horizon_expectancy_vs_training_baseline',
    training_only: true,
  };
}

function defaultWeights(groups = M11_EVIDENCE_GROUPS) {
  return Object.fromEntries(M11_EVIDENCE_GROUPS.map(group => [group, groups.includes(group) ? 1 : 0]));
}

function contributionFor(samples, group) {
  const values = samples.map(sample => {
    const strength = evidenceMap(sample).get(group);
    const outcome = finite(sample.primary_outcome ?? sample.outcome);
    return strength === undefined || outcome === null ? null : { strength, outcome };
  }).filter(Boolean);
  if (!values.length) return {
    sample_count: 0,
    normalized_contribution: 0,
    mean_outcome: null,
  };
  const scale = average(values.map(value => Math.abs(value.outcome))) || 1;
  const normalized = average(values.map(value => value.strength * value.outcome / scale));
  return {
    sample_count: values.length,
    normalized_contribution: round(Math.max(-1, Math.min(1, normalized)), 8),
    mean_outcome: round(average(values.map(value => value.outcome))),
  };
}

function empiricalWeights(samples, groups) {
  const contributions = {};
  const weights = defaultWeights(groups);
  for (const group of M11_EVIDENCE_GROUPS) {
    const contribution = contributionFor(samples, group);
    contributions[group] = contribution;
    if (groups.includes(group) && contribution.sample_count > 0) {
      // Strong shrinkage keeps the score interpretable and close to the
      // equal-weight baseline. Harmful groups are down-weighted, not
      // silently deleted.
      weights[group] = round(Math.max(0.5, Math.min(1.5, 1 + 0.5 * contribution.normalized_contribution)), 8);
    }
  }
  return { weights, contributions };
}

/** Fit equal or regularized independent-group score weights on training data. */
export function fitScorePolicy(trainSamples = [], {
  method = 'equal_weight',
  omitGroup = null,
  setupSpecific = false,
  minimumSamplesPerSetup = 30,
} = {}) {
  const groups = M11_EVIDENCE_GROUPS.filter(group => group !== omitGroup);
  const global = method === 'equal_weight'
    ? { weights: defaultWeights(groups), contributions: Object.fromEntries(M11_EVIDENCE_GROUPS.map(group => [group, contributionFor([], group)])) }
    : empiricalWeights(trainSamples, groups);
  const setupWeights = {};
  const setupContributions = {};
  if (setupSpecific && method !== 'equal_weight') {
    for (const setupFamily of M11_SETUP_FAMILIES) {
      const setupSamples = trainSamples.filter(sample => sample.setup_family === setupFamily);
      if (setupSamples.length < minimumSamplesPerSetup) continue;
      const fitted = empiricalWeights(setupSamples, groups);
      setupWeights[setupFamily] = fitted.weights;
      setupContributions[setupFamily] = fitted.contributions;
    }
  }
  return {
    version: 'm1.1-regularized-independent-group-score-0.1.0',
    training_only: true,
    score_method: method === 'equal_weight'
      ? 'equal_weight_independent_evidence'
      : setupSpecific ? 'regularized_setup_empirical_group_weights' : 'regularized_empirical_group_weights',
    omitted_group: omitGroup,
    groups,
    weights: global.weights,
    contributions: global.contributions,
    setup_weights: setupWeights,
    setup_contributions: setupContributions,
    shrinkage: method === 'equal_weight' ? 0 : 0.5,
    minimum_samples_per_setup: minimumSamplesPerSetup,
  };
}

export function scoreWithPolicy(sample, policy = {}) {
  const setupWeights = policy.setup_weights?.[sample?.setup_family];
  const weights = setupWeights || policy.weights || defaultWeights(policy.groups || M11_EVIDENCE_GROUPS);
  const groups = (policy.groups || M11_EVIDENCE_GROUPS).filter(group => Number(weights[group]) > 0);
  const evidence = evidenceMap(sample);
  const present = groups.filter(group => evidence.has(group));
  if (!present.length) return 50;
  const totalWeight = present.reduce((sum, group) => sum + Number(weights[group]), 0);
  const signed = present.reduce((sum, group) => sum + evidence.get(group) * Number(weights[group]), 0);
  return round(Math.max(0, Math.min(100, 50 + (signed / totalWeight) * 50)), 6);
}

function rankingValue(item) {
  return Number(item.learned_score ?? item.empirical_score ?? item.edge_score ?? item.raw_score) || 0;
}

function selectionKey(sample, index) {
  const event = sample.market_event_id || `timestamp:${sampleTimestamp(sample) ?? index}`;
  return `${event}|${direction(sample)}`;
}

function annotateForSelection(samples, model) {
  const threshold = finite(model.score_threshold);
  const volatilityPolicy = model.volatility_policy || {};
  const gatedRegimes = new Set(volatilityPolicy.selected_regimes || []);
  return samples.map((sample, index) => {
    const learnedScore = scoreWithPolicy(sample, model.score_policy);
    const scoreEligible = threshold === null || learnedScore >= threshold;
    const volatilityEligible = !volatilityPolicy.gate_applied
      || gatedRegimes.has(sample.volatility_regime);
    const eligible = scoreEligible && volatilityEligible;
    return {
      sample: {
        ...sample,
        learned_score: learnedScore,
        empirical_score: learnedScore,
      },
      sample_index: index,
      raw_score_eligible: threshold === null || finite(sample.raw_score) === null || finite(sample.raw_score) >= threshold,
      score_threshold_eligible: scoreEligible,
      score_eligible: eligible,
      volatility_eligible: volatilityEligible,
      eligible,
      selected: false,
      cluster_selected: false,
      selection_status: eligible ? 'SCORE_ELIGIBLE_NOT_SELECTED' : 'SCORE_INELIGIBLE',
      oos_cluster_rank: null,
      oos_ranking_bucket: eligible ? 'WATCH' : 'SHADOW',
    };
  });
}

function rankSelections(predictions, topN) {
  const grouped = new Map();
  for (const item of predictions.filter(item => item.score_eligible === true)) {
    const key = selectionKey(item.sample, item.sample_index);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  for (const members of grouped.values()) {
    members.sort((left, right) => (
      rankingValue(right) - rankingValue(left)
      || String(left.sample?.symbol || '').localeCompare(String(right.sample?.symbol || ''))
      || String(left.sample?.setup_family || '').localeCompare(String(right.sample?.setup_family || ''))
      || left.sample_index - right.sample_index
    ));
    members.forEach((item, index) => {
      item.oos_cluster_rank = index + 1;
      if (index < topN) {
        item.selected = true;
        item.cluster_selected = true;
        item.selection_status = 'CLUSTER_SELECTED';
        item.oos_ranking_bucket = 'CLUSTER_SELECTED';
      }
    });
  }
  return predictions;
}

function trainingTopNScore(annotations, topN) {
  const selected = rankSelections(annotations.map(item => ({
    ...item,
    sample: { ...item.sample },
  })), topN).filter(item => item.selected);
  const outcomes = selected.map(item => finite(item.sample.primary_outcome)).filter(value => value !== null);
  return {
    top_n: topN,
    selected_count: outcomes.length,
    independent_clusters: new Set(selected.map(item => item.sample.market_event_id).filter(Boolean)).size,
    net_expectancy_percent: round(average(outcomes)),
    selection_score: outcomes.length ? round(average(outcomes) - (topN - 1) * 0.01, 8) : null,
  };
}

function selectTrainingTopN(annotations) {
  const metrics = [1, 2].map(topN => trainingTopNScore(annotations, topN));
  const selected = [...metrics].sort((left, right) => (
    (right.selection_score ?? -Infinity) - (left.selection_score ?? -Infinity)
    || left.top_n - right.top_n
  ))[0] || metrics[0];
  return {
    selected_top_n: selected?.top_n ?? 1,
    training_only: true,
    candidates: metrics,
    selection_basis: 'training_primary_outcome_with_simple_top_n_complexity_penalty',
  };
}

function eventSelectionTrainingSummary(samples, windowHours) {
  const eventSamples = applyEventPolicy(samples, windowHours);
  const threshold = median(eventSamples.map(sample => finite(sample.raw_score)).filter(value => value !== null));
  const eligible = eventSamples.filter(sample => threshold === null || (finite(sample.raw_score) !== null && finite(sample.raw_score) >= threshold));
  const annotations = eligible.map((sample, index) => ({
    sample,
    sample_index: index,
    score_eligible: true,
    learned_score: finite(sample.raw_score) ?? 0,
    selected: false,
  }));
  const selected = rankSelections(annotations, 1).filter(item => item.selected);
  const outcomes = selected.map(item => finite(item.sample.primary_outcome)).filter(value => value !== null);
  return {
    window_hours: windowHours,
    eligible_candidates: eligible.length,
    selected_candidates: selected.length,
    independent_clusters: new Set(selected.map(item => item.sample.market_event_id).filter(Boolean)).size,
    net_expectancy_percent: round(average(outcomes)),
    net_profit_factor: round(profitFactor(outcomes), 4),
    selection_score: outcomes.length ? round(average(outcomes) - Math.max(0, 10 - selected.length) * 0.0001, 8) : null,
  };
}

function selectTrainingEventPolicy(samples) {
  const candidates = M11_EVENT_WINDOWS_HOURS.map(windowHours => eventSelectionTrainingSummary(samples, windowHours));
  const selected = [...candidates].sort((left, right) => (
    (right.selection_score ?? -Infinity) - (left.selection_score ?? -Infinity)
    || right.window_hours - left.window_hours
  ))[0] || candidates.find(candidate => candidate.window_hours === 4);
  return {
    version: 'm1.1-training-market-event-policy-0.1.0',
    training_only: true,
    selection_basis: 'training_primary_outcome_with_predeclared_1h_4h_candidates',
    selected_window_hours: selected?.window_hours ?? 4,
    candidates,
  };
}

function fixedEventPolicy(windowHours) {
  return {
    version: 'm1.1-fixed-market-event-policy-0.1.0',
    training_only: true,
    selection_basis: 'predeclared_candidate_configuration',
    selected_window_hours: windowHours,
    candidates: M11_EVENT_WINDOWS_HOURS.map(candidate => ({
      window_hours: candidate,
      selected: candidate === windowHours,
    })),
  };
}

/** Fit every M1.1 policy from one WFO training window. */
export function fitM11Policy(trainSamples = [], candidate = {}) {
  const horizonPolicy = fitHorizonPolicy(trainSamples, candidate.horizon_options);
  const primaryTrain = applyHorizonPolicy(trainSamples, horizonPolicy);
  const eventPolicy = candidate.event_policy === 'train_select'
    ? selectTrainingEventPolicy(primaryTrain)
    : fixedEventPolicy(Number(candidate.event_window_hours) || 4);
  const eventTrain = applyEventPolicy(primaryTrain, eventPolicy.selected_window_hours);
  const volatilityPolicy = fitM11VolatilityPolicy(eventTrain, candidate.volatility_options);
  const scorePolicy = fitScorePolicy(eventTrain, {
    method: candidate.score_method || 'equal_weight',
    omitGroup: candidate.omit_group || null,
    setupSpecific: candidate.score_method === 'empirical_setup',
    minimumSamplesPerSetup: candidate.minimum_samples_per_setup ?? 30,
  });
  const trainScores = eventTrain.map(sample => scoreWithPolicy(sample, scorePolicy)).filter(value => value !== null);
  const scoreThreshold = candidate.score_threshold_method === 'train_quantile_60'
    ? quantile(trainScores, 0.6)
    : median(trainScores);
  const unranked = annotateForSelection(eventTrain, {
    score_policy: scorePolicy,
    score_threshold: scoreThreshold,
    volatility_policy: volatilityPolicy,
  });
  const topNPolicy = candidate.cluster_top_n === 'train_select'
    ? selectTrainingTopN(unranked)
    : {
      selected_top_n: Math.max(1, Math.min(2, Math.floor(Number(candidate.cluster_top_n) || 1))),
      training_only: true,
      selection_basis: 'predeclared_candidate_configuration',
      candidates: [Math.max(1, Math.min(2, Math.floor(Number(candidate.cluster_top_n) || 1)))],
    };
  return {
    version: 'm1.1-edge-policy-0.1.0',
    training_only: true,
    event_policy: eventPolicy,
    horizon_policy: horizonPolicy,
    volatility_policy: volatilityPolicy,
    score_policy: scorePolicy,
    score_threshold: scoreThreshold,
    score_threshold_method: candidate.score_threshold_method || 'train_median',
    cluster_top_n: topNPolicy.selected_top_n,
    cluster_top_n_policy: topNPolicy,
    summary: {
      event_policy: eventPolicy,
      horizon_policy: horizonPolicy,
      volatility_policy: volatilityPolicy,
      score_method: scorePolicy.score_method,
      score_threshold: scoreThreshold,
      cluster_top_n: topNPolicy.selected_top_n,
      training_only: true,
    },
  };
}

/** Apply a frozen policy to test samples and preserve every audit status. */
export function predictM11Selections(testSamples = [], model = {}) {
  const eventHours = model.event_policy?.selected_window_hours ?? 4;
  const eventSamples = applyEventPolicy(testSamples, eventHours);
  const horizonSamples = applyHorizonPolicy(eventSamples, model.horizon_policy);
  const annotations = annotateForSelection(horizonSamples, model);
  return rankSelections(annotations, model.cluster_top_n ?? 1);
}

function defaultM11WfoOptions(sampleCount, requested = {}) {
  const holdoutCount = requested.finalHoldoutCount ?? Math.max(12, Math.floor(sampleCount * 0.2));
  const developmentCount = Math.max(0, sampleCount - holdoutCount);
  const trainSize = requested.trainSize ?? Math.max(60, Math.floor(developmentCount * 0.35));
  const testSize = requested.testSize ?? Math.max(12, Math.floor(developmentCount * 0.06));
  return {
    trainSize,
    testSize,
    step: requested.step ?? testSize,
    finalHoldoutCount: holdoutCount,
    purgeHours: requested.purgeHours ?? 48,
    embargoHours: requested.embargoHours ?? 24,
    labelHorizonHours: requested.labelHorizonHours ?? 48,
    minimumTrainSamples: requested.minimumTrainSamples ?? Math.max(30, Math.floor(trainSize * 0.35)),
    minimumWindows: requested.minimumWindows ?? 6,
  };
}

function deduplicateOos(items = []) {
  const seen = new Set();
  return [...items]
    .sort((left, right) => (left.window_index ?? 0) - (right.window_index ?? 0)
      || (left.timestamp ?? 0) - (right.timestamp ?? 0))
    .filter(item => {
      const key = item.record_index ?? item.sample?.record_index ?? item.sample_index;
      if (key === null || key === undefined || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function compactOosPrediction(item) {
  const sample = item.sample || {};
  return {
    ...sample,
    record_index: item.record_index ?? sample.record_index ?? item.sample_index,
    market_event_id: item.market_event_id ?? sample.market_event_id ?? null,
    window_index: item.window_index ?? null,
    raw_score_eligible: item.raw_score_eligible ?? false,
    score_threshold_eligible: item.score_threshold_eligible ?? item.score_eligible ?? false,
    score_eligible: item.score_eligible ?? false,
    volatility_eligible: item.volatility_eligible ?? false,
    selected: item.selected === true,
    cluster_selected: item.cluster_selected === true,
    selection_status: item.selection_status || (item.selected ? 'CLUSTER_SELECTED' : 'SCORE_INELIGIBLE'),
    oos_cluster_rank: item.oos_cluster_rank ?? null,
    oos_ranking_bucket: item.oos_ranking_bucket ?? null,
  };
}

function primaryNet(record) {
  return finite(record?.primary_outcome)
    ?? netOutcome(record, Number(record?.primary_horizon_hours) || 1);
}

function primaryGross(record) {
  return finite(record?.primary_gross_outcome_percent)
    ?? grossOutcome(record, Number(record?.primary_horizon_hours) || 1);
}

function bucketSummary(records) {
  const net = records.map(primaryNet).filter(value => value !== null);
  const gross = records.map(primaryGross).filter(value => value !== null);
  const mfe = records.map(record => finite(record.mfe_percent)).filter(value => value !== null);
  const mae = records.map(record => finite(record.mae_percent)).filter(value => value !== null);
  const tpFirst = records.filter(record => record.tp_first === true || record.barrier_outcome === 'tp_first').length;
  const slFirst = records.filter(record => record.sl_first === true || record.barrier_outcome === 'sl_first').length;
  const neither = records.filter(record => record.neither === true || record.barrier_outcome === 'neither').length;
  const ambiguous = records.filter(record => record.ambiguous === true || record.barrier_outcome === 'ambiguous_same_candle').length;
  return {
    sample_count: records.length,
    evaluated_count: net.length,
    net_expectancy_percent: round(average(net)),
    gross_expectancy_percent: round(average(gross)),
    net_profit_factor: net.length ? round(profitFactor(net), 4) : null,
    gross_profit_factor: gross.length ? round(profitFactor(gross), 4) : null,
    hit_rate_percent: net.length ? round(net.filter(value => value > 0).length / net.length * 100, 4) : null,
    false_positive_rate_percent: net.length ? round(net.filter(value => value <= 0).length / net.length * 100, 4) : null,
    avg_mfe_percent: round(average(mfe)),
    avg_mae_percent: round(average(mae)),
    tp_first_count: tpFirst,
    sl_first_count: slFirst,
    neither_count: neither,
    ambiguous_count: ambiguous,
    tp_first_rate_percent: records.length ? round(tpFirst / records.length * 100, 4) : null,
    sl_first_rate_percent: records.length ? round(slFirst / records.length * 100, 4) : null,
    conservative_sl_first_count: records.filter(record => record.conservative_barrier_outcome === 'sl_first').length,
  };
}

/** Summarize only the records supplied by the caller (normally selected OOS). */
export function summarizeM11Records(records = [], { horizons = M11_HORIZONS_HOURS } = {}) {
  const primary = records.map(primaryNet).filter(value => value !== null);
  const grossPrimary = records.map(primaryGross).filter(value => value !== null);
  const forwardReturns = {};
  for (const horizon of horizons) {
    const key = outcomeKey(horizon);
    const net = records.map(record => netOutcome(record, horizon)).filter(value => value !== null);
    const gross = records.map(record => grossOutcome(record, horizon)).filter(value => value !== null);
    forwardReturns[key] = {
      count: net.length,
      gross_expectancy_percent: round(average(gross)),
      net_expectancy_percent: round(average(net)),
      gross_profit_factor: gross.length ? round(profitFactor(gross), 4) : null,
      net_profit_factor: net.length ? round(profitFactor(net), 4) : null,
      hit_rate_percent: net.length ? round(net.filter(value => value > 0).length / net.length * 100, 4) : null,
    };
  }
  const eventIds = new Set(records.map(record => record.market_event_id).filter(Boolean));
  const symbols = new Set(records.map(record => record.symbol).filter(Boolean));
  const directionBreadth = Object.fromEntries(['BUY', 'SELL'].map(value => [
    value,
    bucketSummary(records.filter(record => direction(record) === value)),
  ]));
  const setupBreadth = Object.fromEntries(M11_SETUP_FAMILIES.map(value => [
    value,
    bucketSummary(records.filter(record => record.setup_family === value)),
  ]));
  const trendBreadth = Object.fromEntries(['Bull', 'Bear', 'Sideways'].map(value => [
    value,
    bucketSummary(records.filter(record => record.trend_regime === value)),
  ]));
  const volatilityBreadth = Object.fromEntries(['Low', 'Normal', 'High', 'Extreme'].map(value => [
    value,
    bucketSummary(records.filter(record => record.volatility_regime === value)),
  ]));
  const decays = records.map(record => {
    const first = netOutcome(record, 1);
    const last = netOutcome(record, 48);
    return first === null || last === null ? null : last - first;
  }).filter(value => value !== null);
  const calibration = buildScoreCalibration(records.map(record => ({
    raw_score: record.learned_score ?? record.empirical_score ?? record.raw_score,
    outcome: primaryNet(record),
    gross_return_percent: primaryGross(record),
    mfe_percent: record.mfe_percent,
    mae_percent: record.mae_percent,
  })));
  return {
    sample_count: records.length,
    evaluated_count: primary.length,
    selected_oos_signals: records.length,
    independent_market_clusters: eventIds.size,
    gross_profit_factor: grossPrimary.length ? round(profitFactor(grossPrimary), 4) : null,
    net_profit_factor: primary.length ? round(profitFactor(primary), 4) : null,
    gross_expectancy_percent: round(average(grossPrimary)),
    net_expectancy_percent: round(average(primary)),
    hit_rate_percent: primary.length ? round(primary.filter(value => value > 0).length / primary.length * 100, 4) : null,
    false_positive_rate_percent: primary.length ? round(primary.filter(value => value <= 0).length / primary.length * 100, 4) : null,
    avg_mfe_percent: round(average(records.map(record => finite(record.mfe_percent)).filter(value => value !== null))),
    avg_mae_percent: round(average(records.map(record => finite(record.mae_percent)).filter(value => value !== null))),
    tp_first_count: records.filter(record => record.tp_first === true || record.barrier_outcome === 'tp_first').length,
    sl_first_count: records.filter(record => record.sl_first === true || record.barrier_outcome === 'sl_first').length,
    neither_count: records.filter(record => record.neither === true || record.barrier_outcome === 'neither').length,
    ambiguous_count: records.filter(record => record.ambiguous === true || record.barrier_outcome === 'ambiguous_same_candle').length,
    tp_first_rate_percent: records.length
      ? round(records.filter(record => record.tp_first === true || record.barrier_outcome === 'tp_first').length / records.length * 100, 4)
      : null,
    sl_first_rate_percent: records.length
      ? round(records.filter(record => record.sl_first === true || record.barrier_outcome === 'sl_first').length / records.length * 100, 4)
      : null,
    conservative_sl_first_count: records.filter(record => record.conservative_barrier_outcome === 'sl_first').length,
    signal_decay_percent: round(average(decays)),
    forward_returns: forwardReturns,
    symbol_breadth: symbols.size,
    direction_breadth: directionBreadth,
    setup_breadth: setupBreadth,
    trend_regime_breadth: trendBreadth,
    volatility_breadth: volatilityBreadth,
    score_calibration: calibration,
  };
}

export function calculateConcentration(records = []) {
  const shares = values => {
    const counts = new Map();
    for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
    const total = values.length;
    return {
      counts: Object.fromEntries([...counts.entries()].sort((left, right) => right[1] - left[1])),
      max_share: total ? Math.max(...counts.values()) / total : 0,
      max_key: total ? [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? null : null,
    };
  };
  const symbol = shares(records.map(record => record.symbol).filter(Boolean));
  const regime = shares(records.map(record => record.trend_regime).filter(Boolean));
  return {
    symbol,
    regime,
    max_symbol_cluster_share: round(symbol.max_share, 6),
    max_regime_cluster_share: round(regime.max_share, 6),
    concentration_risk: symbol.max_share > 0.3 || regime.max_share > 0.7,
  };
}

function windowMetrics(oosRecords, windows) {
  return windows.map(window => {
    const records = oosRecords.filter(record => record.window_index === window.index && record.selected);
    const metrics = summarizeM11Records(records);
    return {
      window_index: window.index,
      test_start: window.test_start,
      test_end: window.test_end,
      selected_count: records.length,
      net_expectancy_percent: metrics.net_expectancy_percent,
      net_profit_factor: metrics.net_profit_factor,
      positive: (metrics.net_expectancy_percent ?? 0) > 0,
    };
  });
}

function stabilityMetrics(perWindow) {
  const expectancies = perWindow.map(window => window.net_expectancy_percent).filter(value => value !== null);
  const factors = perWindow.map(window => window.net_profit_factor).filter(value => value !== null);
  const positive = perWindow.filter(window => window.positive).length;
  const ratio = perWindow.length ? positive / perWindow.length : 0;
  const medianExpectancy = median(expectancies);
  const worstExpectancy = expectancies.length ? Math.min(...expectancies) : null;
  const medianPf = median(factors);
  const worstPf = factors.length ? Math.min(...factors) : null;
  const unstable = Boolean(
    perWindow.length
    && ((ratio < 2 / 3 && positive > 0) || (medianExpectancy !== null && medianExpectancy <= 0 && worstExpectancy !== null)),
  );
  return {
    median_window_expectancy_percent: round(medianExpectancy),
    worst_window_expectancy_percent: round(worstExpectancy),
    median_window_profit_factor: round(medianPf, 4),
    worst_window_profit_factor: round(worstPf, 4),
    window_expectancy_dispersion_percent: expectancies.length ? round(Math.max(...expectancies) - Math.min(...expectancies)) : null,
    positive_windows: positive,
    total_windows: perWindow.length,
    positive_window_ratio: perWindow.length ? round(ratio, 6) : 0,
    unstable_edge: unstable,
  };
}

/** Run one bounded candidate with a fresh train-only policy per WFO window. */
export function runM11Candidate(samples = [], {
  candidateId = 'candidate',
  candidate = {},
  dataSource = 'public_binance_futures_archive',
  wfoOptions = {},
} = {}) {
  // The plan always uses the widest event definition for its split. A model
  // may train-select 1h later, but it can never make the holdout less isolated.
  const planSamples = applyEventPolicy(samples, 4);
  const options = defaultM11WfoOptions(planSamples.length, wfoOptions);
  options.includeFinalHoldoutOutcomeInHash = false;
  const walkForward = runPurgedWalkForward(planSamples, {
    ...options,
    fit: trainSamples => fitM11Policy(trainSamples, candidate),
    predict: (testSamples, model) => predictM11Selections(testSamples, model),
  });
  const rawOos = walkForward.oos_samples.map(compactOosPrediction);
  const oosRecords = deduplicateOos(rawOos);
  const selectedRecords = oosRecords.filter(record => record.selected === true);
  const scoreEligibleRecords = oosRecords.filter(record => record.score_eligible === true);
  const allMetrics = summarizeM11Records(oosRecords);
  const metrics = summarizeM11Records(selectedRecords);
  const perWindow = windowMetrics(oosRecords, walkForward.windows);
  const stability = stabilityMetrics(perWindow);
  const concentration = calculateConcentration(selectedRecords);
  const calibration = metrics.score_calibration;
  const eventIds = new Set(selectedRecords.map(record => record.market_event_id).filter(Boolean));
  const configHash = hashConfig({ candidateId, candidate });
  return {
    candidate_id: candidateId,
    candidate: {
      ...candidate,
      config_hash: configHash,
    },
    data_source: dataSource,
    config_hash: configHash,
    walk_forward: walkForward,
    oos_records: oosRecords,
    selected_records: selectedRecords,
    metrics,
    all_oos_metrics: allMetrics,
    selection: {
      all_candidates: oosRecords.length,
      score_eligible_candidates: scoreEligibleRecords.length,
      cluster_selected_candidates: selectedRecords.length,
      independent_market_events: eventIds.size,
    },
    per_window: perWindow,
    stability,
    concentration,
    calibration,
    final_holdout_untouched: walkForward.final_holdout_untouched === true,
    model_summaries: walkForward.trained_policy_summary,
  };
}

/** Keep only pre-freeze rows; the timestamp is checked before any label field. */
export function freezeM1DevelopmentRecords(records = [], boundaryTimestamp = M1_FROZEN_HOLDOUT.boundary_timestamp) {
  const boundary = finite(boundaryTimestamp);
  if (boundary === null) throw new Error('M1 frozen holdout boundary must be finite');
  return records
    .filter(record => {
      const timestamp = sampleTimestamp(record);
      return timestamp !== null && timestamp < boundary;
    })
    .map(record => ({ ...record }));
}

export function prepareM11Samples(records = [], {
  maximumLabelHorizonHours = 48,
  boundaryTimestamp = M1_FROZEN_HOLDOUT.boundary_timestamp,
} = {}) {
  const frozen = freezeM1DevelopmentRecords(records, boundaryTimestamp);
  return frozen.filter(record => (
    netOutcome(record, maximumLabelHorizonHours) !== null
    && sampleTimestamp(record) + maximumLabelHorizonHours * HOUR <= boundaryTimestamp
  ));
}

/** Compare the candidate's 1h selected OOS lane against V1 on the same test windows. */
export function compareM11V1(candidateResult, v1Records = []) {
  const windows = candidateResult.walk_forward?.windows || [];
  const candidateOneHour = candidateResult.selected_records.map(record => ({
    ...record,
    primary_horizon_hours: 1,
    primary_outcome: netOutcome(record, 1),
    primary_gross_outcome_percent: grossOutcome(record, 1),
  }));
  const candidateMetrics = summarizeM11Records(candidateOneHour);
  const v1Oos = windows.flatMap(window => {
    const windowRecords = v1Records.filter(record => {
      const timestamp = sampleTimestamp(record);
      return timestamp !== null && timestamp >= window.test_start && timestamp <= window.test_end;
    });
    const eventHours = window.model_summary?.event_policy?.selected_window_hours ?? 4;
    return applyEventPolicy(windowRecords, eventHours);
  });
  const v1Comparable = v1Oos.map(record => ({
    ...record,
    primary_horizon_hours: 1,
    primary_outcome: netOutcome(record, 1),
    primary_gross_outcome_percent: grossOutcome(record, 1),
  }));
  const v1Metrics = summarizeM11Records(v1Comparable);
  return {
    same_data_contract: true,
    same_event_definition: true,
    evaluation_horizon: '1h_selected_oos_comparator',
    v1: v1Metrics,
    candidate: candidateMetrics,
    delta: {
      net_profit_factor: candidateMetrics.net_profit_factor === null || v1Metrics.net_profit_factor === null
        ? null
        : round(candidateMetrics.net_profit_factor - v1Metrics.net_profit_factor),
      net_expectancy_percent: candidateMetrics.net_expectancy_percent === null || v1Metrics.net_expectancy_percent === null
        ? null
        : round(candidateMetrics.net_expectancy_percent - v1Metrics.net_expectancy_percent),
      selected_signals: candidateMetrics.selected_oos_signals - v1Metrics.selected_oos_signals,
    },
  };
}

/** Build the required setup/direction/regime/volatility/evidence slice matrix. */
export function buildAblationMatrix(oosRecords = [], candidateResults = []) {
  const selected = records => records.filter(record => record.selected === true);
  const slice = (name, records) => {
    const selectedRecords = selected(records);
    const metrics = summarizeM11Records(selectedRecords);
    const scoreEligible = records.filter(record => record.score_eligible === true).length;
    const scoreThresholdEligible = records.filter(record => record.score_threshold_eligible === true).length;
    const volatilityEligible = records.filter(record => record.volatility_eligible === true).length;
    const volatilityFiltered = records.filter(record => (
      record.score_threshold_eligible === true && record.volatility_eligible === false
    )).length;
    const outcomesByWindow = new Map();
    for (const record of selectedRecords) {
      const outcome = primaryNet(record);
      if (outcome === null) continue;
      if (!outcomesByWindow.has(record.window_index)) outcomesByWindow.set(record.window_index, []);
      outcomesByWindow.get(record.window_index).push(outcome);
    }
    const positiveWindows = [...outcomesByWindow.values()]
      .filter(values => average(values) > 0).length;
    return {
      slice: name,
      candidates: records.length,
      score_eligible: scoreEligible,
      score_threshold_eligible: scoreThresholdEligible,
      volatility_eligible: volatilityEligible,
      volatility_filtered: volatilityFiltered,
      cluster_selected: selectedRecords.length,
      independent_clusters: metrics.independent_market_clusters,
      net_expectancy_percent: metrics.net_expectancy_percent,
      net_profit_factor: metrics.net_profit_factor,
      gross_expectancy_percent: metrics.gross_expectancy_percent,
      gross_profit_factor: metrics.gross_profit_factor,
      hit_rate_percent: metrics.hit_rate_percent,
      avg_mfe_percent: metrics.avg_mfe_percent,
      avg_mae_percent: metrics.avg_mae_percent,
      tp_first_count: metrics.tp_first_count,
      sl_first_count: metrics.sl_first_count,
      neither_count: metrics.neither_count,
      ambiguous_count: metrics.ambiguous_count,
      calibration: metrics.score_calibration.status,
      positive_wfo_windows: positiveWindows,
      symbol_breadth: metrics.symbol_breadth,
      direction_breadth: Object.values(metrics.direction_breadth).filter(item => item.sample_count > 0).length,
    };
  };
  const compactCandidateMetrics = result => result ? {
    selected_oos_signals: result.metrics?.selected_oos_signals ?? 0,
    independent_market_clusters: result.metrics?.independent_market_clusters ?? 0,
    net_profit_factor: result.metrics?.net_profit_factor ?? null,
    net_expectancy_percent: result.metrics?.net_expectancy_percent ?? null,
    gross_profit_factor: result.metrics?.gross_profit_factor ?? null,
    gross_expectancy_percent: result.metrics?.gross_expectancy_percent ?? null,
    hit_rate_percent: result.metrics?.hit_rate_percent ?? null,
    calibration: result.metrics?.score_calibration?.status || 'CALIBRATION_FAIL',
  } : null;
  const matrix = {
    all: slice('all', oosRecords),
    setup_family: Object.fromEntries(M11_SETUP_FAMILIES.map(value => [
      value,
      slice(value, oosRecords.filter(record => record.setup_family === value)),
    ])),
    direction: Object.fromEntries(['BUY', 'SELL'].map(value => [
      value,
      slice(value, oosRecords.filter(record => direction(record) === value)),
    ])),
    trend_regime: Object.fromEntries(['Bull', 'Bear', 'Sideways'].map(value => [
      value,
      slice(value, oosRecords.filter(record => record.trend_regime === value)),
    ])),
    volatility_regime: Object.fromEntries(['Low', 'Normal', 'High', 'Extreme'].map(value => [
      value,
      slice(value, oosRecords.filter(record => record.volatility_regime === value)),
    ])),
    evidence_groups: Object.fromEntries(M11_EVIDENCE_GROUPS.map(value => [
      value,
      slice(value, oosRecords.filter(record => (record.evidence_groups || []).includes(value))),
    ])),
  };
  matrix.evidence_group_ablation = Object.fromEntries(M11_EVIDENCE_GROUPS.map(group => [group, {
      full_model: matrix.all,
      minus_group: compactCandidateMetrics(candidateResults.find(result => result.candidate.omit_group === group)),
      incremental_value: candidateResults.find(result => result.candidate.omit_group === group)
        ? 'EVALUATED_ON_SELECTED_OOS'
        : 'NOT_EVALUATED',
    }]));
  return matrix;
}

/** Explain the Sideways/Mean Reversion zero-selection path without tuning it. */
export function diagnoseSideways({ oosRecords = [], generationDiagnostics = [] } = {}) {
  const generation = generationDiagnostics.reduce((summary, item) => {
    summary.trigger_windows += item.trigger_windows || 0;
    summary.sideways_trigger_windows += item.trend_regime_triggers?.Sideways || 0;
    summary.sideways_mean_reversion_candidates += item.eligible_setup_candidates_by_trend?.Sideways?.['Mean Reversion'] || 0;
    summary.sideways_setup_candidates = Object.fromEntries(M11_SETUP_FAMILIES.map(setup => [
      setup,
      (summary.sideways_setup_candidates[setup] || 0)
        + (item.eligible_setup_candidates_by_trend?.Sideways?.[setup] || 0),
    ]));
    return summary;
  }, {
    trigger_windows: 0,
    sideways_trigger_windows: 0,
    sideways_mean_reversion_candidates: 0,
    sideways_setup_candidates: Object.fromEntries(M11_SETUP_FAMILIES.map(setup => [setup, 0])),
  });
  const sideways = oosRecords.filter(record => record.trend_regime === 'Sideways');
  const sidewaysMeanReversion = sideways.filter(record => record.setup_family === 'Mean Reversion');
  const scoreThresholdEligible = sideways.filter(record => record.score_threshold_eligible === true).length;
  const volatilityEligible = sideways.filter(record => record.volatility_eligible === true).length;
  const volatilityFiltered = sideways.filter(record => (
    record.score_threshold_eligible === true && record.volatility_eligible === false
  )).length;
  const clusterSelected = sideways.filter(record => record.selected === true).length;
  const rankingExcluded = sideways.filter(record => (
    record.score_eligible === true && record.selected !== true
  )).length;
  const conclusion = generation.sideways_trigger_windows === 0
    ? 'A_SIDEWAYS_CLASSIFIER_TOO_RESTRICTIVE'
    : generation.sideways_mean_reversion_candidates === 0
      ? 'B_MEAN_REVERSION_SETUP_TOO_RESTRICTIVE'
      : sideways.length === 0
        ? 'C_HISTORICAL_MARKET_LACKED_SIDEWAYS_OOS_CANDIDATES'
        : scoreThresholdEligible === 0
          ? 'D_SCORE_RANKING_SUPPRESSION'
          : volatilityEligible === 0
            ? 'D_VOLATILITY_FILTER_SUPPRESSION'
            : clusterSelected === 0 && rankingExcluded > 0
              ? 'D_CLUSTER_RANKING_SUPPRESSION'
              : 'C_HISTORICAL_MARKET_LACKED_VALID_SIDEWAYS_SELECTION';
  return {
    source: 'all primary-candidate OOS records plus prior-only generation counters',
    generation,
    oos: {
      sideways_candidates: sideways.length,
      sideways_mean_reversion_candidates: sidewaysMeanReversion.length,
      score_threshold_eligible: scoreThresholdEligible,
      volatility_eligible: volatilityEligible,
      volatility_filtered: volatilityFiltered,
      cluster_selected: clusterSelected,
      ranking_excluded: rankingExcluded,
    },
    conclusion,
  };
}

export function promotionDiagnostics(candidateResult, {
  independentClusters = 100,
  netProfitFactor = 1.25,
  netExpectancyPercent = 0.15,
  oosWindows = 6,
  positiveWindows = 4,
  symbolBreadth = 8,
  calibration = 'PASS',
} = {}) {
  const metrics = candidateResult.metrics || {};
  const observed = {
    independent_clusters: metrics.independent_market_clusters || 0,
    net_profit_factor: metrics.net_profit_factor || 0,
    net_expectancy_percent: metrics.net_expectancy_percent || 0,
    oos_windows: candidateResult.walk_forward?.window_count || 0,
    positive_windows: candidateResult.walk_forward?.positive_windows || 0,
    positive_window_ratio: candidateResult.stability?.positive_window_ratio || 0,
    symbol_breadth: metrics.symbol_breadth || 0,
    calibration: metrics.score_calibration?.status || 'CALIBRATION_FAIL',
  };
  const failures = [];
  if (observed.independent_clusters < independentClusters) failures.push('independent_clusters');
  if (observed.net_profit_factor < netProfitFactor) failures.push('net_profit_factor');
  if (observed.net_expectancy_percent < netExpectancyPercent) failures.push('net_expectancy_percent');
  if (observed.oos_windows < oosWindows) failures.push('oos_windows');
  if (observed.positive_windows < positiveWindows) failures.push('positive_windows');
  if (observed.positive_window_ratio < 2 / 3) failures.push('positive_window_ratio');
  if (observed.symbol_breadth < symbolBreadth) failures.push('symbol_breadth');
  if (observed.calibration !== calibration) failures.push('calibration');
  const enoughEvidence = observed.independent_clusters >= independentClusters
    && observed.oos_windows >= oosWindows
    && observed.symbol_breadth >= symbolBreadth;
  return {
    recommendation: !enoughEvidence ? 'INSUFFICIENT_EVIDENCE' : failures.length ? 'REJECT' : 'SHADOW_CANDIDATE',
    thresholds: {
      independentClusters,
      netProfitFactor,
      netExpectancyPercent,
      oosWindows,
      positiveWindows,
      positiveWindowRatio: 2 / 3,
      symbolBreadth,
      calibration,
      maxSymbolConcentration: 0.3,
      maxRegimeConcentration: 0.7,
    },
    observed,
    failures,
    concentration: candidateResult.concentration,
    concentration_risk: candidateResult.concentration?.concentration_risk === true,
    unstable_edge: candidateResult.stability?.unstable_edge === true,
    no_threshold_reduction: true,
  };
}

export function candidateSummary(result) {
  return {
    candidate_id: result.candidate_id,
    config_hash: result.config_hash,
    model_version: M11_MODEL_VERSION,
    score_method: result.candidate.score_method || null,
    setup_policy: 'existing_m1_independent_setup_families',
    horizon_policy: result.candidate.horizon_policy || 'train_selected_per_setup',
    event_policy: result.candidate.event_policy === 'fixed'
      ? `fixed_${result.candidate.event_window_hours || 4}h`
      : result.candidate.event_policy || (result.candidate.event_window_hours ? `${result.candidate.event_window_hours}h` : 'train_select_1h_or_4h'),
    cluster_top_n: result.candidate.cluster_top_n,
    features: result.candidate.omit_group
      ? M11_EVIDENCE_GROUPS.filter(group => group !== result.candidate.omit_group)
      : [...M11_EVIDENCE_GROUPS],
    selected_oos_signals: result.metrics.selected_oos_signals,
    independent_oos_clusters: result.metrics.independent_market_clusters,
    net_profit_factor: result.metrics.net_profit_factor,
    net_expectancy_percent: result.metrics.net_expectancy_percent,
    positive_windows: result.stability.positive_windows,
    total_windows: result.stability.total_windows,
    positive_window_ratio: result.stability.positive_window_ratio,
    calibration: result.metrics.score_calibration.status,
    promotion: result.promotion || null,
  };
}

export { primaryNet, primaryGross, sampleTimestamp, netOutcome, grossOutcome };

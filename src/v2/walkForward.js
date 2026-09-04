// Purged walk-forward research protocol. The final holdout is never supplied
// to fit/predict callbacks and is split on timestamp/event boundaries.

import { hashConfig } from '../lineage.js';

const HOUR = 60 * 60 * 1000;
const VOLATILITY_REGIMES = ['Low', 'Normal', 'High', 'Extreme'];
const VOLATILITY_POLICY_VERSION = 'm1-training-volatility-policy-0.1.0';

function numericTime(value) {
  const candidate = value?.timestamp ?? value?.signal_timestamp ?? value;
  if (Number.isFinite(Number(candidate))) return Number(candidate);
  const parsed = Date.parse(candidate || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function eventId(sample) {
  const value = sample?.market_event_id ?? sample?.event_id;
  return value === null || value === undefined || value === '' ? null : String(value);
}

function direction(sample) {
  return String(sample?.direction ?? sample?.signal ?? '').toUpperCase() || 'UNKNOWN';
}

function labelEndTime(sample, horizonHours) {
  const value = numericTime(sample?.label_end_time ?? sample?.horizon_end_time);
  return value ?? ((numericTime(sample) ?? 0) + horizonHours * HOUR);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function scoreValue(sample, field = 'raw_score') {
  const value = Number(sample?.[field]);
  return Number.isFinite(value) ? value : null;
}

function outcomeValue(sample) {
  const value = Number(sample?.outcome ?? sample?.net_return_percent);
  return Number.isFinite(value) ? value : null;
}

function rankingValue(sample) {
  return scoreValue(sample, 'edge_score') ?? scoreValue(sample, 'raw_score') ?? 0;
}

function rankingKey(sample, index) {
  const timestamp = numericTime(sample);
  const event = eventId(sample) || `timestamp:${timestamp ?? index}`;
  return `${event}|${direction(sample)}`;
}

function finalHoldoutSplit(ordered, requestedCount) {
  const holdoutCount = Math.max(0, Math.min(requestedCount, ordered.length));
  if (!holdoutCount) return { development: ordered, finalHoldout: [], startIndex: ordered.length };

  let startIndex = ordered.length - holdoutCount;
  const alignTimestampBoundary = () => {
    const boundary = ordered[startIndex]?.timestamp;
    while (startIndex > 0 && ordered[startIndex - 1].timestamp === boundary) startIndex -= 1;
  };
  alignTimestampBoundary();

  // Move the boundary back if a market event selected for holdout has an
  // earlier member. Repeat because moving it can expose another event.
  let changed = true;
  while (changed) {
    changed = false;
    const holdoutEvents = new Set(
      ordered.slice(startIndex).map(item => eventId(item.sample)).filter(Boolean),
    );
    for (let index = 0; index < startIndex; index += 1) {
      if (holdoutEvents.has(eventId(ordered[index].sample))) {
        startIndex = index;
        alignTimestampBoundary();
        changed = true;
        break;
      }
    }
  }

  return {
    development: ordered.slice(0, startIndex),
    finalHoldout: ordered.slice(startIndex),
    startIndex,
  };
}

/** Assert the timestamp and market-event isolation of a final holdout. */
export function assertHoldoutIsolation(development = [], finalHoldout = []) {
  const developmentMaxTimestamp = development.at(-1)?.timestamp ?? null;
  const finalHoldoutMinTimestamp = finalHoldout[0]?.timestamp ?? null;
  const developmentEvents = new Set(development.map(item => eventId(item.sample ?? item)).filter(Boolean));
  const finalHoldoutEvents = new Set(finalHoldout.map(item => eventId(item.sample ?? item)).filter(Boolean));
  const eventIntersection = [...developmentEvents].filter(value => finalHoldoutEvents.has(value));
  const timestampSeparated = finalHoldout.length === 0
    ? false
    : developmentMaxTimestamp === null || finalHoldoutMinTimestamp === null
      ? false
      : developmentMaxTimestamp < finalHoldoutMinTimestamp;
  const passed = timestampSeparated && eventIntersection.length === 0;
  if (!passed) {
    throw new Error(`Final holdout isolation failed: timestamp=${timestampSeparated}, event_intersection=${eventIntersection.length}`);
  }
  return {
    passed: true,
    development_max_timestamp: developmentMaxTimestamp,
    final_holdout_min_timestamp: finalHoldoutMinTimestamp,
    event_intersection_count: eventIntersection.length,
    event_intersection: eventIntersection,
  };
}

export const assertFinalHoldoutIsolation = assertHoldoutIsolation;

/**
 * Select a volatility policy from training observations only. A gate is not
 * applied when there is insufficient per-regime evidence or no selective
 * training improvement over the training baseline.
 */
export function selectTrainingVolatilityPolicy(trainSamples = [], {
  minimumSamplesPerRegime = 20,
  minimumRegimes = 2,
  minimumImprovementPercent = 0,
} = {}) {
  const byRegime = Object.fromEntries(VOLATILITY_REGIMES.map(regime => [regime, []]));
  for (const sample of trainSamples) {
    const regime = sample?.volatility_regime;
    const outcome = outcomeValue(sample);
    if (byRegime[regime] && outcome !== null) byRegime[regime].push(outcome);
  }
  const allOutcomes = Object.values(byRegime).flat();
  const baseline = average(allOutcomes);
  const perRegime = Object.fromEntries(VOLATILITY_REGIMES.map(regime => {
    const values = byRegime[regime];
    return [regime, {
      sample_count: values.length,
      net_expectancy_percent: average(values),
      sufficiently_sampled: values.length >= minimumSamplesPerRegime,
    }];
  }));
  const sufficientlySampled = VOLATILITY_REGIMES.filter(regime => perRegime[regime].sufficiently_sampled);
  const evidenceSufficient = sufficientlySampled.length >= minimumRegimes && baseline !== null;
  const selected = evidenceSufficient
    ? sufficientlySampled.filter(regime => perRegime[regime].net_expectancy_percent
      >= baseline + minimumImprovementPercent)
    : [];
  const gateApplied = evidenceSufficient
    && selected.length > 0
    && selected.length < sufficientlySampled.length;

  return {
    version: VOLATILITY_POLICY_VERSION,
    training_only: true,
    gate_applied: gateApplied,
    selected_regimes: gateApplied ? selected : null,
    evidence_sufficient: evidenceSufficient,
    minimum_samples_per_regime: minimumSamplesPerRegime,
    minimum_regimes: minimumRegimes,
    minimum_improvement_percent: minimumImprovementPercent,
    training_baseline_expectancy_percent: baseline,
    per_regime: perRegime,
    selection_basis: 'training_net_1h_expectancy_vs_training_baseline',
    reason: !evidenceSufficient
      ? 'INSUFFICIENT_TRAINING_VOLATILITY_EVIDENCE'
      : !gateApplied
        ? 'NO_SELECTIVE_TRAINING_VOLATILITY_IMPROVEMENT'
        : 'SELECTED_TRAINING_REGIMES_ONLY',
  };
}

/** Fit the fixed score/cluster protocol using only one training window. */
export function fitClusterSelectionPolicy(trainSamples = [], options = {}) {
  const threshold = median(trainSamples.map(sample => scoreValue(sample, 'raw_score')).filter(value => value !== null));
  const clusterTopN = Math.max(1, Math.floor(Number(options.clusterTopN ?? 1)) || 1);
  const volatilityPolicy = selectTrainingVolatilityPolicy(trainSamples, options);
  return {
    version: 'm1-oos-selection-policy-0.1.0',
    score_field: 'raw_score',
    threshold,
    cluster_top_n: clusterTopN,
    volatility_policy: volatilityPolicy,
    summary: {
      version: 'm1-oos-selection-policy-0.1.0',
      score_field: 'raw_score',
      score_threshold: threshold,
      cluster_top_n: clusterTopN,
      volatility_policy: volatilityPolicy,
    },
  };
}

/** Apply score eligibility, then top-N ranking within each event/direction. */
export function predictClusterSelections(testSamples = [], model = {}, {
  clusterTopN = model.cluster_top_n ?? 1,
} = {}) {
  const threshold = Number.isFinite(Number(model.threshold)) ? Number(model.threshold) : null;
  const topN = Math.max(1, Math.floor(Number(clusterTopN)) || 1);
  const volatilityPolicy = model.volatility_policy || {};
  const gatedRegimes = new Set(volatilityPolicy.selected_regimes || []);
  const eligible = [];
  const annotated = testSamples.map((sample, index) => {
    const rawScore = scoreValue(sample, 'raw_score');
    const rawScoreEligible = threshold === null || (rawScore !== null && rawScore >= threshold);
    const volatilityEligible = !volatilityPolicy.gate_applied
      || gatedRegimes.has(sample?.volatility_regime);
    const scoreEligible = rawScoreEligible && volatilityEligible;
    const item = {
      sample,
      sample_index: index,
      raw_score_eligible: rawScoreEligible,
      volatility_eligible: volatilityEligible,
      score_eligible: scoreEligible,
      eligible: scoreEligible,
      cluster_selected: false,
      selected: false,
      selection_status: scoreEligible ? 'SCORE_ELIGIBLE_NOT_SELECTED' : 'SCORE_INELIGIBLE',
      oos_cluster_rank: null,
      oos_ranking_bucket: scoreEligible ? 'WATCH' : 'SHADOW',
    };
    if (scoreEligible) eligible.push(item);
    return item;
  });
  const grouped = new Map();
  eligible.forEach(item => {
    const key = rankingKey(item.sample, item.sample_index);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  });
  for (const members of grouped.values()) {
    members.sort((left, right) => {
      return rankingValue(right.sample) - rankingValue(left.sample)
        || String(left.sample?.symbol || '').localeCompare(String(right.sample?.symbol || ''))
        || String(left.sample?.setup_family || '').localeCompare(String(right.sample?.setup_family || ''))
        || left.sample_index - right.sample_index;
    });
    members.forEach((item, rank) => {
      item.oos_cluster_rank = rank + 1;
      if (rank < topN) {
        item.cluster_selected = true;
        item.selected = true;
        item.selection_status = 'CLUSTER_SELECTED';
        item.oos_ranking_bucket = 'CLUSTER_SELECTED';
      }
    });
  }
  return annotated;
}

function defaultScoreWindow(predictions) {
  const selected = predictions.filter(item => item.selected === true);
  const selectedOutcomes = selected.map(item => outcomeValue(item.sample)).filter(value => value !== null);
  const total = selectedOutcomes.reduce((sum, value) => sum + value, 0);
  return {
    candidate_count: predictions.length,
    score_eligible_count: predictions.filter(item => item.score_eligible === true).length,
    cluster_selected_count: selected.length,
    selected_count: selected.length,
    independent_market_events: new Set(selected.map(item => eventId(item.sample)).filter(Boolean)).size,
    expectancy: selectedOutcomes.length ? total / selectedOutcomes.length : null,
    positive: selectedOutcomes.length > 0 && total > 0,
  };
}

/**
 * Create rolling windows over the development set. Training labels are purged
 * at each test boundary; an embargo is also applied before each test. The
 * final holdout is a chronological, timestamp/event-isolated suffix.
 */
export function buildPurgedWalkForwardPlan(samples = [], options = {}) {
  const {
    trainSize = 100,
    testSize = 20,
    step = testSize,
    finalHoldoutCount = Math.max(1, Math.floor(samples.length * 0.2)),
    purgeHours = 48,
    embargoHours = 24,
    labelHorizonHours = 48,
    minimumTrainSamples = Math.max(1, Math.floor(trainSize * 0.5)),
  } = options;
  const ordered = samples
    .map((sample, originalIndex) => ({ sample, originalIndex, timestamp: numericTime(sample) }))
    .filter(item => item.timestamp !== null)
    .sort((a, b) => a.timestamp - b.timestamp || a.originalIndex - b.originalIndex);
  const split = finalHoldoutSplit(ordered, finalHoldoutCount);
  const development = split.development;
  const finalHoldout = split.finalHoldout;
  const holdoutAssertions = finalHoldout.length
    ? assertHoldoutIsolation(development, finalHoldout)
    : {
      passed: false,
      development_max_timestamp: development.at(-1)?.timestamp ?? null,
      final_holdout_min_timestamp: null,
      event_intersection_count: 0,
      event_intersection: [],
    };
  const holdoutStart = finalHoldout[0]?.timestamp ?? null;
  const embargoMs = embargoHours * HOUR;
  const boundaryExcluded = holdoutStart === null
    ? []
    : development.filter(item => (
      labelEndTime(item.sample, labelHorizonHours) > holdoutStart
      || item.timestamp > holdoutStart - embargoMs
    ));
  const wfoDevelopment = holdoutStart === null
    ? development
    : development.filter(item => (
      labelEndTime(item.sample, labelHorizonHours) <= holdoutStart
      && item.timestamp <= holdoutStart - embargoMs
    ));
  const holdoutPurged = holdoutStart === null
    ? []
    : development.filter(item => labelEndTime(item.sample, labelHorizonHours) > holdoutStart);
  const holdoutEmbargoed = holdoutStart === null
    ? []
    : development.filter(item => item.timestamp > holdoutStart - embargoMs);
  const windows = [];
  const safeTrainSize = Math.max(1, trainSize);
  const safeTestSize = Math.max(1, testSize);
  const safeStep = Math.max(1, step);

  for (let cursor = 0; cursor + safeTrainSize < wfoDevelopment.length; cursor += safeStep) {
    const trainEndIndex = cursor + safeTrainSize;
    const rawTestStart = wfoDevelopment[trainEndIndex]?.timestamp;
    if (rawTestStart === undefined) break;
    const embargoStart = rawTestStart + embargoMs;
    const testStartIndex = wfoDevelopment.findIndex((item, index) => index >= trainEndIndex && item.timestamp >= embargoStart);
    if (testStartIndex < 0) break;
    const testEndIndex = Math.min(testStartIndex + safeTestSize, wfoDevelopment.length);
    const testItems = wfoDevelopment.slice(testStartIndex, testEndIndex);
    if (!testItems.length) break;
    const trainItems = wfoDevelopment.slice(cursor, trainEndIndex).filter(item => {
      return labelEndTime(item.sample, labelHorizonHours) <= rawTestStart;
    });
    if (trainItems.length < minimumTrainSamples) continue;
    windows.push({
      index: windows.length,
      train: trainItems.map(item => item.originalIndex),
      test: testItems.map(item => item.originalIndex),
      train_start: trainItems[0]?.timestamp ?? null,
      train_end: trainItems.at(-1)?.timestamp ?? null,
      raw_test_start: rawTestStart,
      test_start: testItems[0]?.timestamp ?? null,
      test_end: testItems.at(-1)?.timestamp ?? null,
      purge_hours: purgeHours,
      embargo_hours: embargoHours,
      purged_count: safeTrainSize - trainItems.length,
      embargoed_count: testStartIndex - trainEndIndex,
    });
    if (testEndIndex >= wfoDevelopment.length) break;
  }

  const includeFinalHoldoutOutcomeInHash = options.includeFinalHoldoutOutcomeInHash !== false;
  const finalHoldoutHash = finalHoldout.length
    ? hashConfig(finalHoldout.map(item => ({
      timestamp: item.timestamp,
      market_event_id: eventId(item.sample),
      symbol: item.sample?.symbol ?? null,
      direction: direction(item.sample),
      setup_family: item.sample?.setup_family ?? null,
      raw_score: scoreValue(item.sample, 'raw_score'),
      ...(includeFinalHoldoutOutcomeInHash ? { outcome: outcomeValue(item.sample) } : {}),
    })))
    : null;
  const boundary = {
    requested_count: Math.max(0, finalHoldoutCount),
    actual_count: finalHoldout.length,
    boundary_timestamp: holdoutStart,
    development_max_timestamp: holdoutAssertions.development_max_timestamp,
    final_holdout_min_timestamp: holdoutAssertions.final_holdout_min_timestamp,
    final_holdout_max_timestamp: finalHoldout.at(-1)?.timestamp ?? null,
    all_boundary_timestamps_single_side: holdoutAssertions.passed,
    purge_hours: purgeHours,
    embargo_hours: embargoHours,
    purged_development_count: holdoutPurged.length,
    embargoed_development_count: holdoutEmbargoed.length,
    excluded_development_count: boundaryExcluded.length,
    wfo_development_max_timestamp: wfoDevelopment.at(-1)?.timestamp ?? null,
    final_holdout_hash: finalHoldoutHash,
    assertions: holdoutAssertions,
  };

  return {
    windows,
    ordered_indices: ordered.map(item => item.originalIndex),
    development_indices: development.map(item => item.originalIndex),
    wfo_development_indices: wfoDevelopment.map(item => item.originalIndex),
    final_holdout_indices: finalHoldout.map(item => item.originalIndex),
    final_holdout_count: finalHoldout.length,
    final_holdout_start: holdoutStart,
    final_holdout_hash: finalHoldoutHash,
    final_holdout_boundary: boundary,
    final_holdout_untouched: holdoutAssertions.passed,
    options: {
      trainSize: safeTrainSize,
      testSize: safeTestSize,
      step: safeStep,
      purgeHours,
      embargoHours,
      labelHorizonHours,
      includeFinalHoldoutOutcomeInHash,
    },
  };
}

/** Execute the plan with optional training and prediction callbacks. */
export function runPurgedWalkForward(samples = [], options = {}) {
  const plan = buildPurgedWalkForwardPlan(samples, options);
  const fit = options.fit || ((trainSamples, fitOptions) => fitClusterSelectionPolicy(trainSamples, {
    ...options,
    ...fitOptions,
  }));
  const predict = options.predict || ((testSamples, model) => predictClusterSelections(testSamples, model, options));
  const scoreWindow = options.scoreWindow || defaultScoreWindow;
  const windowResults = [];
  const oosSamples = [];
  const finalHoldoutSet = new Set(plan.final_holdout_indices);
  const sampleIndexByReference = new Map(samples.map((sample, index) => [sample, index]));
  let windowsAvoidHoldout = true;

  for (const window of plan.windows) {
    if (window.train.some(index => finalHoldoutSet.has(index)) || window.test.some(index => finalHoldoutSet.has(index))) {
      windowsAvoidHoldout = false;
    }
    const trainSamples = window.train.map(index => samples[index]);
    const testSamples = window.test.map(index => samples[index]);
    const model = fit(trainSamples, { window, plan });
    const rawPredictions = predict(testSamples, model, { window, plan });
    const predictions = (rawPredictions || []).map((prediction, index) => {
      if (prediction?.sample) return prediction;
      return { sample: testSamples[index], selected: Boolean(prediction) };
    });
    const metrics = scoreWindow(predictions, { window, model });
    windowResults.push({
      ...window,
      metrics,
      model_summary: model?.summary || null,
    });
    predictions.forEach(prediction => {
      const sample = prediction.sample;
      const sampleIndex = sampleIndexByReference.get(sample) ?? samples.indexOf(sample);
      oosSamples.push({
        ...prediction,
        window_index: window.index,
        sample_index: sampleIndex,
        record_index: sample?.record_index ?? sampleIndex,
        market_event_id: eventId(sample),
        symbol: sample?.symbol ?? null,
        direction: sample?.direction ?? sample?.signal ?? null,
        setup_family: sample?.setup_family ?? null,
        cluster_rank: sample?.cluster_rank ?? null,
        ranking_bucket: sample?.ranking_bucket ?? null,
        raw_score: scoreValue(sample, 'raw_score'),
        edge_score: scoreValue(sample, 'edge_score'),
        timestamp: numericTime(sample),
        outcome: outcomeValue(sample),
      });
    });
  }
  const positiveWindows = windowResults.filter(window => window.metrics?.positive === true).length;
  const oosEvents = new Set(oosSamples.map(sample => sample.market_event_id).filter(Boolean));
  const holdoutUntouched = plan.final_holdout_untouched && windowsAvoidHoldout;
  return {
    ...plan,
    windows: windowResults,
    window_count: windowResults.length,
    positive_windows: positiveWindows,
    oos_samples: oosSamples,
    oos_candidate_counts: {
      all_candidates: oosSamples.length,
      score_eligible_candidates: oosSamples.filter(sample => sample.score_eligible === true).length,
      cluster_selected_candidates: oosSamples.filter(sample => sample.selected === true).length,
      independent_market_events: oosEvents.size,
    },
    trained_policy_summary: windowResults.map(window => ({
      window_index: window.index,
      test_start: window.test_start,
      test_end: window.test_end,
      model_summary: window.model_summary,
    })),
    final_holdout_untouched: holdoutUntouched,
    status: windowResults.length >= (options.minimumWindows || 6) ? 'PASS' : 'INSUFFICIENT_EVIDENCE',
  };
}

export const purgedWalkForward = runPurgedWalkForward;

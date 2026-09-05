// Purged walk-forward research protocol. The final holdout is never supplied
// to fit/predict callbacks and is split on timestamp/event boundaries.

import { hashConfig } from '../lineage.js';

const HOUR = 60 * 60 * 1000;
const VOLATILITY_REGIMES = ['Low', 'Normal', 'High', 'Extreme'];
const VOLATILITY_POLICY_VERSION = 'm1-training-volatility-policy-0.1.0';
const CANONICAL_WFO_VERSION = 'm1.3-time-wfo-0.1.1';

function numericTime(value) {
  const candidate = value?.timestamp ?? value?.signal_timestamp ?? value;
  if (Number.isFinite(Number(candidate))) return Number(candidate);
  const parsed = Date.parse(candidate || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function eventId(sample) {
  const value = sample?.independent_market_event_id ?? sample?.market_event_id ?? sample?.event_id;
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

function canonicalEventGroups(samples = []) {
  const groups = new Map();
  samples.forEach((sample, index) => {
    const timestamp = numericTime(sample);
    if (timestamp === null) return;
    const id = eventId(sample) || `timestamp:${timestamp}`;
    if (!groups.has(id)) groups.set(id, {
      event_id: id,
      start_timestamp: timestamp,
      end_timestamp: timestamp,
      snapshot_timestamps: new Set(),
    });
    const group = groups.get(id);
    group.start_timestamp = Math.min(group.start_timestamp, timestamp);
    group.end_timestamp = Math.max(group.end_timestamp, timestamp);
    group.snapshot_timestamps.add(timestamp);
    group.first_sample_index = Math.min(group.first_sample_index ?? index, index);
  });
  return [...groups.values()]
    .map(group => ({
      ...group,
      snapshot_timestamps: [...group.snapshot_timestamps].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.start_timestamp - right.start_timestamp || left.event_id.localeCompare(right.event_id));
}

function canonicalWindowProjection(windows = []) {
  return windows.map(window => ({
    index: window.index,
    train_start_timestamp: window.train_start_timestamp ?? window.train_start ?? null,
    train_end_timestamp: window.train_end_timestamp ?? window.train_end ?? null,
    purge_start_timestamp: window.purge_start_timestamp ?? window.purge_start ?? null,
    purge_end_timestamp: window.purge_end_timestamp ?? window.purge_end ?? null,
    test_start_timestamp: window.test_start_timestamp ?? window.test_start ?? null,
    test_end_timestamp: window.test_end_timestamp ?? window.test_end ?? null,
    embargo_start_timestamp: window.embargo_start_timestamp ?? window.embargo_start ?? null,
    embargo_end_timestamp: window.embargo_end_timestamp ?? window.embargo_end ?? null,
    embargo_boundary_timestamp: window.embargo_boundary_timestamp ?? null,
    final_holdout_start_timestamp: window.final_holdout_start_timestamp
      ?? window.final_holdout_start
      ?? null,
    purge_hours: window.purge_hours ?? null,
    embargo_hours: window.embargo_hours ?? null,
  }));
}

/**
 * Build one time/event-based WFO calendar that can be materialized against
 * sparse or dense candidate samples without changing any calendar boundary.
 */
export function buildCanonicalWfoPlan(samples = [], options = {}) {
  const {
    trainRatio = 0.35,
    testRatio = 0.06,
    holdoutRatio = 0.20,
    trainEventCount: requestedTrainEventCount,
    testEventCount: requestedTestEventCount,
    stepEventCount: requestedStepEventCount,
    finalHoldoutStartTimestamp: requestedHoldoutStart,
    purgeHours = 48,
    embargoHours = 24,
    labelHorizonHours = 48,
    minimumWindows = 6,
    includeFinalHoldoutOutcomeInHash = false,
  } = options;
  const clock = canonicalEventGroups(samples);
  if (clock.length < 3) throw new Error('Canonical WFO requires at least three independent market events');
  const holdoutEventCount = Math.max(1, Math.floor(clock.length * holdoutRatio));
  const requestedBoundary = numericTime(requestedHoldoutStart);
  let holdoutIndex = requestedBoundary === null
    ? clock.length - holdoutEventCount
    : clock.findIndex(event => event.start_timestamp === requestedBoundary);
  if (holdoutIndex < 1) throw new Error('Canonical WFO final holdout boundary is not present after development history');
  const finalHoldoutStart = clock[holdoutIndex].start_timestamp;
  if (requestedBoundary !== null && finalHoldoutStart !== requestedBoundary) {
    throw new Error(`Canonical WFO final holdout boundary mismatch: requested=${requestedBoundary}, actual=${finalHoldoutStart}`);
  }
  const developmentClock = clock.slice(0, holdoutIndex);
  const holdoutStart = finalHoldoutStart;
  const holdoutPurgeCutoff = holdoutStart - labelHorizonHours * HOUR;
  const holdoutEmbargoCutoff = holdoutStart - embargoHours * HOUR;
  const wfoClock = developmentClock.filter(event => (
    event.end_timestamp + labelHorizonHours * HOUR <= holdoutStart
    && event.start_timestamp <= holdoutEmbargoCutoff
  ));
  const trainEventCount = Math.max(1, Math.floor(
    requestedTrainEventCount ?? clock.length * trainRatio,
  ));
  const testEventCount = Math.max(1, Math.floor(
    requestedTestEventCount ?? clock.length * testRatio,
  ));
  const stepEventCount = Math.max(1, Math.floor(requestedStepEventCount ?? testEventCount));
  const windows = [];
  for (let cursor = 0; cursor + trainEventCount < wfoClock.length; cursor += stepEventCount) {
    const trainAnchorEnd = cursor + trainEventCount;
    const rawTestEvent = wfoClock[trainAnchorEnd];
    if (!rawTestEvent) break;
    const rawTestStart = rawTestEvent.start_timestamp;
    const trainEvents = wfoClock.slice(cursor, trainAnchorEnd).filter(event => (
      event.end_timestamp + labelHorizonHours * HOUR <= rawTestStart
    ));
    const embargoBoundary = rawTestStart + embargoHours * HOUR;
    const testStartIndex = wfoClock.findIndex((event, index) => (
      index >= trainAnchorEnd && event.start_timestamp >= embargoBoundary
    ));
    if (testStartIndex < 0) break;
    const testEvents = wfoClock.slice(testStartIndex, testStartIndex + testEventCount);
    if (!testEvents.length) break;
    const trainStart = trainEvents[0]?.start_timestamp ?? wfoClock[cursor]?.start_timestamp ?? null;
    const trainEnd = trainEvents.at(-1)?.end_timestamp ?? null;
    const testStart = testEvents[0].start_timestamp;
    const testEnd = testEvents.at(-1).end_timestamp;
    windows.push({
      index: windows.length,
      train: trainEvents.map(event => event.event_id),
      test: testEvents.map(event => event.event_id),
      train_start: trainStart,
      train_end: trainEnd,
      raw_test_start: rawTestStart,
      test_start: testStart,
      test_end: testEnd,
      train_start_timestamp: trainStart,
      train_end_timestamp: trainEnd,
      purge_start_timestamp: trainEnd === null ? null : trainEnd + 1,
      purge_end_timestamp: rawTestStart - 1,
      test_start_timestamp: testStart,
      test_end_timestamp: testEnd,
      embargo_start_timestamp: rawTestStart,
      embargo_end_timestamp: testStart - 1,
      embargo_boundary_timestamp: embargoBoundary,
      final_holdout_start_timestamp: finalHoldoutStart,
      purge_hours: purgeHours,
      embargo_hours: embargoHours,
      label_horizon_hours: labelHorizonHours,
      train_event_count: trainEvents.length,
      test_event_count: testEvents.length,
      purged_event_count: Math.max(0, trainAnchorEnd - trainEvents.length),
      embargoed_event_count: Math.max(0, testStartIndex - trainAnchorEnd),
    });
    if (testStartIndex + testEventCount >= wfoClock.length) break;
  }
  if (!windows.length) throw new Error('Canonical WFO produced no chronological windows');
  const finalHoldoutEvents = clock.slice(holdoutIndex);
  const boundary = {
    requested_count: holdoutEventCount,
    actual_count: finalHoldoutEvents.length,
    boundary_timestamp: finalHoldoutStart,
    final_holdout_start_timestamp: finalHoldoutStart,
    final_holdout_event_id: finalHoldoutEvents[0]?.event_id ?? null,
    development_max_timestamp: developmentClock.at(-1)?.end_timestamp ?? null,
    final_holdout_min_timestamp: finalHoldoutEvents[0]?.start_timestamp ?? null,
    final_holdout_max_timestamp: finalHoldoutEvents.at(-1)?.end_timestamp ?? null,
    all_boundary_timestamps_single_side: true,
    purge_hours: purgeHours,
    embargo_hours: embargoHours,
    holdout_purge_cutoff_timestamp: holdoutPurgeCutoff,
    holdout_embargo_cutoff_timestamp: holdoutEmbargoCutoff,
    wfo_development_max_timestamp: wfoClock.at(-1)?.end_timestamp ?? null,
  };
  const finalHoldoutHash = hashConfig(finalHoldoutEvents.map(event => ({
    event_id: event.event_id,
    start_timestamp: event.start_timestamp,
    end_timestamp: event.end_timestamp,
    ...(includeFinalHoldoutOutcomeInHash ? { outcome: null } : {}),
  })));
  const optionsSummary = {
    canonical_wfo: true,
    canonical_wfo_version: CANONICAL_WFO_VERSION,
    canonical_clock_unit: 'independent_market_event_id',
    canonical_clock_event_count: clock.length,
    trainRatio,
    testRatio,
    holdoutRatio,
    trainSize: trainEventCount,
    testSize: testEventCount,
    step: stepEventCount,
    finalHoldoutCount: finalHoldoutEvents.length,
    purgeHours,
    embargoHours,
    labelHorizonHours,
    includeFinalHoldoutOutcomeInHash,
    minimumWindows,
  };
  const canonicalPlanHash = hashConfig({
    version: CANONICAL_WFO_VERSION,
    options: optionsSummary,
    boundary,
    windows: canonicalWindowProjection(windows),
  });
  const optionsWithHash = { ...optionsSummary, canonical_plan_hash: canonicalPlanHash };
  return {
    canonical_wfo: true,
    canonical_wfo_version: CANONICAL_WFO_VERSION,
    canonical_plan_hash: canonicalPlanHash,
    canonical_clock_unit: 'independent_market_event_id',
    canonical_clock_event_count: clock.length,
    canonical_clock_start_timestamp: clock[0].start_timestamp,
    canonical_clock_end_timestamp: clock.at(-1).end_timestamp,
    canonical_clock_snapshot_count: clock.reduce((sum, event) => sum + event.snapshot_timestamps.length, 0),
    wfo_development_event_count: wfoClock.length,
    wfo_development_max_timestamp: wfoClock.at(-1)?.end_timestamp ?? null,
    windows,
    final_holdout_start: finalHoldoutStart,
    final_holdout_start_timestamp: finalHoldoutStart,
    final_holdout_event_id: finalHoldoutEvents[0]?.event_id ?? null,
    final_holdout_event_count: finalHoldoutEvents.length,
    final_holdout_hash: finalHoldoutHash,
    final_holdout_boundary: { ...boundary, final_holdout_hash: finalHoldoutHash },
    final_holdout_untouched: true,
    options: optionsWithHash,
  };
}

function materializeCanonicalWfoPlan(samples = [], canonicalPlan, options = {}) {
  const ordered = samples
    .map((sample, originalIndex) => ({ sample, originalIndex, timestamp: numericTime(sample) }))
    .filter(item => item.timestamp !== null)
    .sort((left, right) => left.timestamp - right.timestamp || left.originalIndex - right.originalIndex);
  const finalHoldoutStart = canonicalPlan.final_holdout_start_timestamp;
  const labelHorizonHours = canonicalPlan.options?.labelHorizonHours ?? options.labelHorizonHours ?? 48;
  const finalHoldoutIndices = ordered
    .filter(item => item.timestamp >= finalHoldoutStart)
    .map(item => item.originalIndex);
  const developmentIndices = ordered
    .filter(item => item.timestamp < finalHoldoutStart)
    .map(item => item.originalIndex);
  const wfoDevelopmentMax = canonicalPlan.wfo_development_max_timestamp;
  const wfoDevelopmentIndices = ordered
    .filter(item => item.timestamp <= wfoDevelopmentMax
      && labelEndTime(item.sample, labelHorizonHours) <= finalHoldoutStart)
    .map(item => item.originalIndex);
  const windows = canonicalPlan.windows.map(canonicalWindow => {
    const train = [];
    const test = [];
    ordered.forEach(item => {
      if (item.timestamp >= canonicalWindow.train_start_timestamp
        && item.timestamp <= canonicalWindow.train_end_timestamp
        && labelEndTime(item.sample, labelHorizonHours) <= canonicalWindow.raw_test_start) {
        train.push(item.originalIndex);
      }
      if (item.timestamp >= canonicalWindow.test_start_timestamp
        && item.timestamp <= canonicalWindow.test_end_timestamp) {
        test.push(item.originalIndex);
      }
    });
    return {
      ...canonicalWindow,
      train,
      test,
      train_sample_count: train.length,
      test_sample_count: test.length,
    };
  });
  return {
    ...canonicalPlan,
    windows,
    window_count: windows.length,
    ordered_indices: ordered.map(item => item.originalIndex),
    development_indices: developmentIndices,
    wfo_development_indices: wfoDevelopmentIndices,
    final_holdout_indices: finalHoldoutIndices,
    final_holdout_count: finalHoldoutIndices.length,
    final_holdout_untouched: canonicalPlan.final_holdout_untouched === true,
    final_holdout_boundary: {
      ...canonicalPlan.final_holdout_boundary,
      candidate_final_holdout_count: finalHoldoutIndices.length,
    },
    options: { ...canonicalPlan.options },
  };
}

/** Execute the plan with optional training and prediction callbacks. */
export function runPurgedWalkForward(samples = [], options = {}) {
  const plan = options.canonicalPlan
    ? materializeCanonicalWfoPlan(samples, options.canonicalPlan, options)
    : buildPurgedWalkForwardPlan(samples, options);
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

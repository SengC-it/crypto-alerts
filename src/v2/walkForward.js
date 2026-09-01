// Purged walk-forward research protocol. The final holdout is never supplied
// to fit/predict callbacks.

function numericTime(value) {
  const candidate = value?.timestamp ?? value?.signal_timestamp ?? value;
  if (Number.isFinite(Number(candidate))) return Number(candidate);
  const parsed = Date.parse(candidate || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function labelEndTime(sample, horizonHours) {
  const value = numericTime(sample?.label_end_time ?? sample?.horizon_end_time);
  return value ?? ((numericTime(sample) ?? 0) + horizonHours * 60 * 60 * 1000);
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Create rolling windows over the development set. Purge removes training
 * labels that overlap the test start; embargo leaves a time gap before test.
 */
export function buildPurgedWalkForwardPlan(samples = [], options = {}) {
  const {
    trainSize = 100,
    testSize = 20,
    step = testSize,
    purgeHours = 48,
    embargoHours = 24,
    finalHoldoutCount = Math.max(1, Math.floor(samples.length * 0.2)),
    labelHorizonHours = 48,
    minimumTrainSamples = Math.max(1, Math.floor(trainSize * 0.5)),
  } = options;
  const ordered = samples
    .map((sample, originalIndex) => ({ sample, originalIndex, timestamp: numericTime(sample) }))
    .filter(item => item.timestamp !== null)
    .sort((a, b) => a.timestamp - b.timestamp || a.originalIndex - b.originalIndex);
  const holdoutCount = Math.max(0, Math.min(finalHoldoutCount, ordered.length));
  const development = ordered.slice(0, ordered.length - holdoutCount);
  const finalHoldout = ordered.slice(ordered.length - holdoutCount);
  const windows = [];
  const embargoMs = embargoHours * 60 * 60 * 1000;
  const safeTrainSize = Math.max(1, trainSize);
  const safeTestSize = Math.max(1, testSize);
  const safeStep = Math.max(1, step);

  for (let cursor = 0; cursor + safeTrainSize < development.length; cursor += safeStep) {
    const trainEndIndex = cursor + safeTrainSize;
    const rawTestStart = development[trainEndIndex]?.timestamp;
    if (rawTestStart === undefined) break;
    const embargoStart = rawTestStart + embargoMs;
    const testStartIndex = development.findIndex((item, index) => index >= trainEndIndex && item.timestamp >= embargoStart);
    if (testStartIndex < 0) break;
    const testEndIndex = Math.min(testStartIndex + safeTestSize, development.length);
    const testItems = development.slice(testStartIndex, testEndIndex);
    if (!testItems.length) break;
    // Purge labels that overlap the pre-embargo test boundary. `purgeHours`
    // documents the label horizon used by the protocol; comparing label end
    // times is stricter and remains correct when observations are irregular.
    const purgeCutoff = rawTestStart;
    const trainItems = development.slice(cursor, trainEndIndex).filter(item => {
      return labelEndTime(item.sample, labelHorizonHours) <= purgeCutoff;
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
    if (testEndIndex >= development.length) break;
  }

  return {
    windows,
    ordered_indices: ordered.map(item => item.originalIndex),
    development_indices: development.map(item => item.originalIndex),
    final_holdout_indices: finalHoldout.map(item => item.originalIndex),
    final_holdout_count: finalHoldout.length,
    final_holdout_start: finalHoldout[0]?.timestamp ?? null,
    final_holdout_untouched: true,
    options: { trainSize: safeTrainSize, testSize: safeTestSize, step: safeStep, purgeHours, embargoHours, labelHorizonHours },
  };
}

/** Execute the plan with optional training and prediction callbacks. */
export function runPurgedWalkForward(samples = [], options = {}) {
  const plan = buildPurgedWalkForwardPlan(samples, options);
  const fit = options.fit || ((trainSamples) => ({ threshold: median(trainSamples.map(sample => Number(sample.raw_score))) }));
  const predict = options.predict || ((testSamples, model) => testSamples.map(sample => ({
    sample,
    selected: model.threshold === null || Number(sample.raw_score) >= model.threshold,
  })));
  const scoreWindow = options.scoreWindow || ((predictions) => {
    const selected = predictions.filter(item => item.selected).map(item => Number(item.sample.outcome)).filter(Number.isFinite);
    return {
      selected_count: selected.length,
      expectancy: selected.length ? selected.reduce((sum, value) => sum + value, 0) / selected.length : null,
      positive: selected.length > 0 && selected.reduce((sum, value) => sum + value, 0) > 0,
    };
  });
  const windowResults = [];
  const oosSamples = [];
  for (const window of plan.windows) {
    const trainSamples = window.train.map(index => samples[index]);
    const testSamples = window.test.map(index => samples[index]);
    const model = fit(trainSamples, { window, plan });
    const rawPredictions = predict(testSamples, model, { window, plan });
    const predictions = (rawPredictions || []).map((prediction, index) => {
      if (prediction?.sample) return prediction;
      return { sample: testSamples[index], selected: Boolean(prediction) };
    });
    const metrics = scoreWindow(predictions, { window, model });
    windowResults.push({ ...window, metrics, model_summary: model?.summary || null });
    predictions.forEach(prediction => oosSamples.push({
      ...prediction,
      window_index: window.index,
      sample_index: samples.indexOf(prediction.sample),
    }));
  }
  const positiveWindows = windowResults.filter(window => window.metrics?.positive === true).length;
  return {
    ...plan,
    windows: windowResults,
    window_count: windowResults.length,
    positive_windows: positiveWindows,
    oos_samples: oosSamples,
    status: windowResults.length >= (options.minimumWindows || 6) ? 'PASS' : 'INSUFFICIENT_EVIDENCE',
  };
}

export const purgedWalkForward = runPurgedWalkForward;

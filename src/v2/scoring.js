// V2 ranking score and calibration. edge_score is never presented as a
// probability; until calibration passes it is only an ordering value.

import { getEvidenceGroupWeights } from './evidence.js';

export const SCORE_SEMANTICS = 'ranking_score_not_probability';

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function round(value, digits = 6) {
  return Number.isFinite(value) ? +value.toFixed(digits) : null;
}

export function calculateRawScore(evidence, { groupWeights = {} } = {}) {
  const weights = getEvidenceGroupWeights(groupWeights);
  const accepted = evidence?.accepted || [];
  if (!accepted.length) return 0;
  let weighted = 0;
  let totalWeight = 0;
  for (const entry of accepted) {
    const weight = Number(entry.weight ?? weights[entry.group] ?? 0);
    if (!Number.isFinite(weight) || weight <= 0) continue;
    const strength = clamp(Number(entry.strength) || 0, -1, 1);
    weighted += weight * ((strength + 1) / 2);
    totalWeight += weight;
  }
  return totalWeight ? round(clamp(weighted / totalWeight * 100, 0, 100), 4) : 0;
}

function calibrationAdjustment(rawScore, calibration) {
  if (calibration?.status !== 'PASS') return 0;
  const bin = (calibration.bins || []).find(item => rawScore >= item.lower && rawScore <= item.upper);
  if (!bin || !Number.isFinite(bin.net_expectancy_percent)) return 0;
  return clamp(bin.net_expectancy_percent * 8, -10, 10);
}

export function calculateEdgeScore(rawScore, calibration = null) {
  const score = finite(rawScore) ?? 0;
  return round(clamp(score + calibrationAdjustment(score, calibration), 0, 100), 4);
}

export function scoreCandidate({ evidence, calibration = null } = {}) {
  const rawScore = calculateRawScore(evidence);
  return {
    raw_score: rawScore,
    edge_score: calculateEdgeScore(rawScore, calibration),
    score_semantics: SCORE_SEMANTICS,
    calibrated: calibration?.status === 'PASS',
    evidence_group_count: evidence?.independent_group_count || 0,
  };
}

function profitFactor(values) {
  const wins = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  if (!losses) return wins > 0 ? 999 : 0;
  return wins / losses;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/**
 * Quantile bins are used only to test ordering quality of scores on OOS
 * outcomes. A bin is not a win-probability statement.
 */
export function buildScoreCalibration(samples = [], {
  binCount = 5,
  minimumSamplesPerBin = 5,
} = {}) {
  const valid = samples
    .map((sample, index) => ({ ...sample, _index: index, raw_score: finite(sample?.raw_score), outcome: finite(sample?.outcome ?? sample?.net_return_percent) }))
    .filter(sample => sample.raw_score !== null && sample.outcome !== null)
    .sort((a, b) => a.raw_score - b.raw_score || a._index - b._index);
  const bins = [];
  for (let binIndex = 0; binIndex < binCount; binIndex++) {
    const start = Math.floor(binIndex * valid.length / binCount);
    const end = Math.floor((binIndex + 1) * valid.length / binCount);
    const values = valid.slice(start, end);
    const outcomes = values.map(value => value.outcome);
    const mfe = values.map(value => finite(value.mfe_percent)).filter(value => value !== null);
    const mae = values.map(value => finite(value.mae_percent)).filter(value => value !== null);
    bins.push({
      index: binIndex,
      lower: values[0]?.raw_score ?? null,
      upper: values.at(-1)?.raw_score ?? null,
      count: values.length,
      hit_rate_percent: outcomes.length ? +(outcomes.filter(value => value > 0).length / outcomes.length * 100).toFixed(4) : null,
      gross_expectancy_percent: round(mean(values.map(value => finite(value.gross_return_percent)).filter(value => value !== null))),
      net_expectancy_percent: round(mean(outcomes)),
      profit_factor: round(profitFactor(outcomes), 4),
      mfe_percent: round(mean(mfe)),
      mae_percent: round(mean(mae)),
    });
  }
  const populated = bins.filter(bin => bin.count > 0);
  const monotonic = populated.every((bin, index) => index === 0
    || bin.net_expectancy_percent === null
    || populated[index - 1].net_expectancy_percent === null
    || bin.net_expectancy_percent >= populated[index - 1].net_expectancy_percent);
  const enoughSamples = valid.length >= binCount * minimumSamplesPerBin
    && bins.every(bin => bin.count >= minimumSamplesPerBin);
  return {
    status: enoughSamples && monotonic ? 'PASS' : 'CALIBRATION_FAIL',
    score_semantics: SCORE_SEMANTICS,
    no_probability_claim: true,
    sample_count: valid.length,
    bin_count: binCount,
    minimum_samples_per_bin: minimumSamplesPerBin,
    monotonic_oos_expectancy: monotonic,
    enough_samples: enoughSamples,
    bins,
  };
}

export const fitScoreCalibration = buildScoreCalibration;

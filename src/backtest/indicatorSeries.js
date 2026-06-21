import { computeAllIndicators } from '../indicators/index.js';

export function precomputeIndicatorSeries(candles, options = {}) {
  const {
    warmup = 100,
    computeFn = computeAllIndicators,
  } = options;

  const series = Array(candles.length).fill(null);
  for (let i = warmup; i < candles.length; i++) {
    series[i] = computeFn(candles.slice(0, i + 1));
  }
  return series;
}

import { computeAllIndicators } from '../indicators/index.js';
import { CONFIG, getIndicatorLookback } from '../config.js';
import { filterClosedCandles } from '../market/candle.js';
import { createIndicatorSnapshot } from '../indicators/provenance.js';

export function precomputeIndicatorSeries(candles, options = {}) {
  const {
    computeFn = computeAllIndicators,
  } = options;
  const timeframe = options.timeframe || '1h';
  const lookbackCandles = getIndicatorLookback(options.config || CONFIG, options);
  const normalizedCandles = filterClosedCandles(candles, {
    symbol: options.symbol,
    timeframe,
    now: options.now,
  });
  const symbol = options.symbol || normalizedCandles.at(-1)?.symbol || '';

  const series = Array(normalizedCandles.length).fill(null);
  for (let i = lookbackCandles - 1; i < normalizedCandles.length; i++) {
    const indicatorWindow = normalizedCandles.slice(i - lookbackCandles + 1, i + 1);
    const computed = computeFn(indicatorWindow, {
      index: i,
      candles: indicatorWindow,
      symbol,
      timeframe,
      lookbackCandles,
    });
    series[i] = createIndicatorSnapshot(computed, {
      symbol,
      timeframe,
      candles: indicatorWindow,
      lookbackCandles,
    });
  }
  return series;
}

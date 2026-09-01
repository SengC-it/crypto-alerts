// Independent M1 setup families. These rules do not wrap the V1 Bollinger,
// Donchian or strategy-manager implementations.

import {
  V2_TRIGGER_TIMEFRAME,
  median,
  mean,
  standardDeviation,
} from './canonical.js';

export const SETUP_FAMILIES = Object.freeze([
  'Trend Continuation',
  'Mean Reversion',
  'Breakout',
]);

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function noSetup(name, reason, candle) {
  return {
    eligible: false,
    setup_family: name,
    reason,
    direction: null,
    trigger_time: candle?.close_time ?? null,
    timeframe: V2_TRIGGER_TIMEFRAME,
  };
}

function setup(name, direction, candle, reason, features = {}) {
  return {
    eligible: true,
    setup_family: name,
    direction,
    reason,
    trigger_time: candle.close_time,
    trigger_open_time: candle.open_time,
    timeframe: V2_TRIGGER_TIMEFRAME,
    entry_reference: candle.close,
    feature_values: features,
  };
}

export function trendContinuationSetup(candles, regime, {
  trendLookback = 8,
} = {}) {
  const current = candles.at(-1);
  const prior = candles.slice(-(trendLookback + 1), -1);
  if (!current || prior.length < trendLookback) {
    return noSetup('Trend Continuation', 'INSUFFICIENT_TRIGGER_HISTORY', current);
  }
  if (!['Bull', 'Bear'].includes(regime?.trend_regime)) {
    return noSetup('Trend Continuation', 'REGIME_NOT_TRENDING', current);
  }

  const previousClose = finite(prior.at(-1)?.close);
  const currentClose = finite(current.close);
  const priorMean = mean(prior.map(candle => candle.close));
  const direction = regime.trend_regime === 'Bull' ? 'BUY' : 'SELL';
  const continuation = direction === 'BUY'
    ? currentClose > previousClose && currentClose > priorMean
    : currentClose < previousClose && currentClose < priorMean;
  if (!continuation) return noSetup('Trend Continuation', 'NO_CONTINUATION_CONFIRMATION', current);

  return setup(
    'Trend Continuation',
    direction,
    current,
    'Trend structure and trigger-direction continuation confirmed',
    {
      prior_mean: priorMean,
      previous_close: previousClose,
      current_close: currentClose,
      trend_regime: regime.trend_regime,
    },
  );
}

export function meanReversionSetup(candles, regime, {
  referenceLookback = 20,
  deviationThreshold = 1.5,
} = {}) {
  const current = candles.at(-1);
  const previous = candles.at(-2);
  const reference = candles.slice(-(referenceLookback + 2), -2);
  if (!current || !previous || reference.length < referenceLookback) {
    return noSetup('Mean Reversion', 'INSUFFICIENT_REFERENCE_HISTORY', current);
  }
  if (regime?.trend_regime !== 'Sideways') {
    return noSetup('Mean Reversion', 'REGIME_NOT_SIDEWAYS', current);
  }

  // Robust median/MAD reference, with the current trigger candle excluded.
  // This is intentionally not a Bollinger-band reimplementation.
  const referenceCloses = reference.map(candle => finite(candle.close)).filter(value => value !== null);
  const center = median(referenceCloses);
  const deviations = referenceCloses.map(value => Math.abs(value - center));
  const mad = median(deviations);
  const scale = Math.max((mad ?? 0) * 1.4826, standardDeviation(referenceCloses) ?? 0, Number.EPSILON);
  const previousClose = finite(previous.close);
  const currentClose = finite(current.close);
  const previousZ = (previousClose - center) / scale;
  const currentZ = (currentClose - center) / scale;
  const buy = previousZ <= -deviationThreshold && currentClose > previousClose;
  const sell = previousZ >= deviationThreshold && currentClose < previousClose;
  if (!buy && !sell) return noSetup('Mean Reversion', 'NO_REVERSION_CONFIRMATION', current);

  const direction = buy ? 'BUY' : 'SELL';
  return setup(
    'Mean Reversion',
    direction,
    current,
    'Robust deviation extreme followed by direction reversal',
    {
      reference_center: center,
      reference_scale: scale,
      previous_z: +previousZ.toFixed(6),
      current_z: +currentZ.toFixed(6),
    },
  );
}

export function breakoutSetup(candles, {
  structureLookback = 20,
} = {}) {
  const current = candles.at(-1);
  const prior = candles.slice(-(structureLookback + 1), -1);
  if (!current || prior.length < structureLookback) {
    return noSetup('Breakout', 'INSUFFICIENT_PRIOR_STRUCTURE', current);
  }

  const priorHigh = Math.max(...prior.map(candle => Number(candle.high)));
  const priorLow = Math.min(...prior.map(candle => Number(candle.low)));
  const currentClose = finite(current.close);
  if (currentClose > priorHigh) {
    return setup(
      'Breakout',
      'BUY',
      current,
      'Closed candle broke the prior structure high',
      { prior_structure_high: priorHigh, prior_structure_low: priorLow, current_close: currentClose },
    );
  }
  if (currentClose < priorLow) {
    return setup(
      'Breakout',
      'SELL',
      current,
      'Closed candle broke the prior structure low',
      { prior_structure_high: priorHigh, prior_structure_low: priorLow, current_close: currentClose },
    );
  }
  return noSetup('Breakout', 'NO_PRIOR_STRUCTURE_BREAK', current);
}

export function evaluateSetupFamilies(candles, regime, options = {}) {
  return [
    trendContinuationSetup(candles, regime, options.trendContinuation),
    meanReversionSetup(candles, regime, options.meanReversion),
    breakoutSetup(candles, options.breakout),
  ];
}

export function eligibleSetups(candles, regime, options = {}) {
  return evaluateSetupFamilies(candles, regime, options).filter(result => result.eligible);
}

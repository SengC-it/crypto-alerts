// Deterministic, closed-candle regime classification for the M1 shadow lane.

import {
  V2_CONTEXT_TIMEFRAME,
  V2_TRIGGER_TIMEFRAME,
  canonicalClosedWindow,
  mean,
  quantile,
  rollingNatrPercent,
} from './canonical.js';
import { filterClosedCandles } from '../market/candle.js';

export const TREND_REGIMES = Object.freeze(['Bull', 'Bear', 'Sideways']);
export const VOLATILITY_REGIMES = Object.freeze(['Low', 'Normal', 'High', 'Extreme']);

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function closeValues(candles) {
  return (candles || []).map(candle => finite(candle.close)).filter(value => value !== null);
}

function classifyTrend(contextCandles, {
  minimumContextCandles = 8,
  trendThresholdPercent = 0.35,
} = {}) {
  const closes = closeValues(contextCandles);
  if (closes.length < minimumContextCandles) {
    return {
      trend_regime: 'Sideways',
      trend_status: 'INSUFFICIENT_CONTEXT',
      trend_slope_percent: null,
      context_candles: closes.length,
    };
  }

  const fast = mean(closes.slice(-5));
  const slow = mean(closes.slice(-Math.min(20, closes.length)));
  const first = closes.at(-Math.min(20, closes.length));
  const last = closes.at(-1);
  const slope = first && last ? ((last - first) / first) * 100 : null;
  const separation = slow ? ((last - slow) / slow) * 100 : null;
  const directional = (slope ?? 0) >= trendThresholdPercent && (separation ?? 0) >= 0
    ? 'Bull'
    : (slope ?? 0) <= -trendThresholdPercent && (separation ?? 0) <= 0
      ? 'Bear'
      : 'Sideways';

  return {
    trend_regime: directional,
    trend_status: 'CALIBRATED_FROM_PRIOR_CONTEXT',
    trend_slope_percent: slope === null ? null : +slope.toFixed(6),
    fast_context_mean: fast === null ? null : +fast.toFixed(8),
    slow_context_mean: slow === null ? null : +slow.toFixed(8),
    context_candles: closes.length,
  };
}

function volatilityHistory(candles, lookback) {
  const values = [];
  for (let index = lookback + 1; index < candles.length; index++) {
    const value = rollingNatrPercent(candles.slice(0, index), lookback);
    if (value !== null) values.push(value);
  }
  return values;
}

function classifyVolatility(triggerCandles, {
  volatilityLookback = 14,
  minimumCalibrationObservations = 12,
} = {}) {
  const current = rollingNatrPercent(triggerCandles, volatilityLookback);
  const prior = volatilityHistory(triggerCandles.slice(0, -1), volatilityLookback);
  if (current === null || prior.length < minimumCalibrationObservations) {
    return {
      volatility_regime: 'Normal',
      volatility_status: 'INSUFFICIENT_CALIBRATION',
      natr_percent: current === null ? null : +current.toFixed(6),
      volatility_observations: prior.length,
      volatility_bands: null,
    };
  }

  // Bands are empirical quantiles of prior observations. No fixed NATR cutoff
  // is promoted as a profitability claim.
  const bands = {
    low: quantile(prior, 0.2),
    normal: quantile(prior, 0.5),
    high: quantile(prior, 0.8),
  };
  const regime = current <= bands.low
    ? 'Low'
    : current <= bands.normal
      ? 'Normal'
      : current <= bands.high
        ? 'High'
        : 'Extreme';
  return {
    volatility_regime: regime,
    volatility_status: 'CALIBRATED_FROM_PRIOR_TRIGGER_HISTORY',
    natr_percent: +current.toFixed(6),
    volatility_observations: prior.length,
    volatility_bands: Object.fromEntries(Object.entries(bands).map(([key, value]) => [key, +value.toFixed(6)])),
  };
}

export class RegimeEngine {
  constructor(options = {}) {
    this.options = {
      minimumContextCandles: 8,
      trendThresholdPercent: 0.35,
      volatilityLookback: 14,
      minimumCalibrationObservations: 12,
      ...options,
    };
  }

  classify({ triggerCandles, contextCandles, asOf = Date.now(), symbol } = {}) {
    const trigger = filterClosedCandles(triggerCandles || [], {
      symbol,
      timeframe: V2_TRIGGER_TIMEFRAME,
      now: asOf,
    });
    const context = filterClosedCandles(contextCandles || [], {
      symbol,
      timeframe: V2_CONTEXT_TIMEFRAME,
      now: asOf,
    });
    const trend = classifyTrend(context, this.options);
    const volatility = classifyVolatility(trigger, this.options);
    const triggerCandle = trigger.at(-1);
    const contextCandle = context.at(-1);
    return {
      ...trend,
      ...volatility,
      trigger_time: triggerCandle?.close_time ?? null,
      context_time: contextCandle?.close_time ?? null,
      trigger_timeframe: V2_TRIGGER_TIMEFRAME,
      context_timeframe: V2_CONTEXT_TIMEFRAME,
      lookahead_safe: true,
      as_of: asOf,
    };
  }
}

export function classifyRegime(options) {
  return new RegimeEngine(options?.engineOptions).classify(options);
}

export { classifyTrend, classifyVolatility };

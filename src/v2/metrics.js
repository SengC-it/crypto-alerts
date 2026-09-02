// SignalEvaluator aggregation for M1 research. These values describe signal
// outcomes, not a user's account return.

import { DEFAULT_HORIZONS_HOURS } from '../evaluation/signalEvaluator.js';
import { buildScoreCalibration } from './scoring.js';

const REGIMES = ['Bull', 'Bear', 'Sideways'];
const VOLATILITIES = ['Low', 'Normal', 'High', 'Extreme'];
const DIRECTIONS = ['BUY', 'SELL'];

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function round(value, digits = 6) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function factor(values) {
  const wins = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return losses ? wins / losses : wins > 0 ? 999 : 0;
}

function primaryOutcome(record) {
  return finite(record?.evaluation?.net_forward_returns?.['1h']
    ?? record?.net_forward_returns?.['1h']);
}

function barrierValue(record, field) {
  return record?.evaluation?.[field] ?? record?.[field] ?? null;
}

function normalizeRecord(record) {
  if (record?.evaluation) {
    return {
      ...record,
      ...record.evaluation,
      signal: record.signal || {},
      raw_score: record.raw_score ?? record.signal?.raw_score,
    };
  }
  return { ...record, signal: record.signal || record };
}

function bucketSummary(records) {
  const normalized = records.map(normalizeRecord);
  const outcomes = normalized.map(primaryOutcome).filter(value => value !== null);
  return {
    sample_count: normalized.length,
    evaluated_count: outcomes.length,
    net_expectancy_percent: round(average(outcomes)),
    net_profit_factor: round(factor(outcomes), 4),
    hit_rate_percent: outcomes.length ? round(outcomes.filter(value => value > 0).length / outcomes.length * 100, 4) : null,
    false_positive_rate_percent: outcomes.length ? round(outcomes.filter(value => value <= 0).length / outcomes.length * 100, 4) : null,
  };
}

export function toEvaluationRecord(signal, evaluation) {
  return {
    signal,
    evaluation,
    symbol: signal?.symbol ?? evaluation?.symbol ?? null,
    direction: signal?.direction ?? signal?.signal ?? evaluation?.direction ?? null,
    setup_family: signal?.setup_family ?? null,
    trend_regime: signal?.trend_regime ?? signal?.regime?.trend_regime ?? null,
    volatility_regime: signal?.volatility_regime ?? signal?.regime?.volatility_regime ?? null,
    market_event_id: signal?.market_event_id ?? null,
    cluster_rank: signal?.cluster_rank ?? null,
    ranking_bucket: signal?.ranking_bucket ?? null,
    trigger_time: signal?.trigger_time ?? signal?.signal_timestamp ?? null,
    label_end_time: signal?.label_end_time ?? null,
    targetPrice: signal?.targetPrice ?? null,
    stopLoss: signal?.stopLoss ?? null,
    barrier: signal?.barrier ?? null,
    barrier_version: signal?.barrier_version ?? signal?.barrier?.barrier_version ?? null,
    barrier_config_hash: signal?.barrier_config_hash ?? signal?.barrier?.barrier_config_hash ?? null,
    raw_score: finite(signal?.raw_score),
    edge_score: finite(signal?.edge_score),
  };
}

export function summarizeEvaluations(records = [], {
  horizons = DEFAULT_HORIZONS_HOURS,
  calibrationOptions = {},
} = {}) {
  const normalized = records.map(normalizeRecord);
  const validPrimary = normalized.map(primaryOutcome).filter(value => value !== null);
  const forwardReturns = {};
  for (const horizon of horizons) {
    const key = `${horizon}h`;
    const gross = normalized.map(record => finite(record.forward_returns?.[key])).filter(value => value !== null);
    const net = normalized.map(record => finite(record.net_forward_returns?.[key])).filter(value => value !== null);
    forwardReturns[key] = {
      count: net.length,
      gross_expectancy_percent: round(average(gross)),
      net_expectancy_percent: round(average(net)),
      hit_rate_percent: net.length ? round(net.filter(value => value > 0).length / net.length * 100, 4) : null,
    };
  }

  const mfe = normalized.map(record => finite(record.mfe_percent)).filter(value => value !== null);
  const mae = normalized.map(record => finite(record.mae_percent)).filter(value => value !== null);
  const decays = normalized.map(record => finite(record.signal_decay)).filter(value => value !== null);
  const eventIds = new Set(normalized.map(record => record.market_event_id).filter(Boolean));
  const symbols = new Set(normalized.map(record => record.symbol).filter(Boolean));
  const directionBreadth = Object.fromEntries(DIRECTIONS.map(direction => [direction, bucketSummary(normalized.filter(record => String(record.direction).toUpperCase() === direction))]));
  const regimeBreadth = Object.fromEntries(REGIMES.map(regime => [
    regime,
    bucketSummary(normalized.filter(record => record.trend_regime === regime)),
  ]));
  const volatilityBreadth = Object.fromEntries(VOLATILITIES.map(regime => [
    regime,
    bucketSummary(normalized.filter(record => record.volatility_regime === regime)),
  ]));
  const calibrationSamples = normalized.map(record => ({
    raw_score: record.raw_score,
    outcome: primaryOutcome(record),
      gross_return_percent: finite(record.evaluation?.forward_returns?.['1h'] ?? record.forward_returns?.['1h']),
      mfe_percent: finite(record.evaluation?.mfe_percent ?? record.mfe_percent),
      mae_percent: finite(record.evaluation?.mae_percent ?? record.mae_percent),
  }));

  return {
    sample_count: normalized.length,
    evaluated_count: validPrimary.length,
    forward_returns: forwardReturns,
    gross_expectancy_percent: forwardReturns['1h']?.gross_expectancy_percent ?? null,
    net_expectancy_percent: forwardReturns['1h']?.net_expectancy_percent ?? null,
    net_profit_factor: round(factor(validPrimary), 4),
    hit_rate_percent: validPrimary.length ? round(validPrimary.filter(value => value > 0).length / validPrimary.length * 100, 4) : null,
    false_positive_rate_percent: validPrimary.length ? round(validPrimary.filter(value => value <= 0).length / validPrimary.length * 100, 4) : null,
    avg_mfe_percent: round(average(mfe)),
    avg_mae_percent: round(average(mae)),
    tp_first_count: normalized.filter(record => (record.evaluation?.tp_first ?? record.tp_first) === true).length,
    sl_first_count: normalized.filter(record => (record.evaluation?.sl_first ?? record.sl_first) === true).length,
    neither_count: normalized.filter(record => barrierValue(record, 'neither') === true
      || barrierValue(record, 'barrier_outcome') === 'neither').length,
    ambiguous_count: normalized.filter(record => barrierValue(record, 'ambiguous') === true
      || barrierValue(record, 'barrier_outcome') === 'ambiguous_same_candle').length,
    conservative_sl_first_count: normalized.filter(record => barrierValue(record, 'conservative_barrier_outcome') === 'sl_first').length,
    barrier_evaluated_count: normalized.filter(record => barrierValue(record, 'barrier_outcome') !== null).length,
    signal_decay_percent: round(average(decays)),
    independent_market_clusters: eventIds.size,
    symbol_breadth: symbols.size,
    direction_breadth: directionBreadth,
    regime_breadth: regimeBreadth,
    volatility_breadth: volatilityBreadth,
    score_calibration: buildScoreCalibration(calibrationSamples, calibrationOptions),
  };
}

export { REGIMES, VOLATILITIES, DIRECTIONS };

// The single signal-generation entry point for live, serverless and backtest.

import { CONFIG } from '../config.js';
import {
  candleToIso,
  filterClosedCandles,
  normalizeCandles,
  assertClosedCandle,
} from '../market/candle.js';
import { computeAllIndicators } from '../indicators/index.js';
import { runStrategies, filterSignals, applyProfitFilter } from '../strategies/manager.js';
import { buildLineage, hashConfig } from '../lineage.js';

export function buildStrategyConfigs(config = CONFIG, strategyOverrides = {}) {
  const overrides = strategyOverrides || {};
  const configs = {};

  for (const [key, defaults] of Object.entries(config.DEFAULT_STRATEGIES || {})) {
    const override = overrides[key] || {};
    const paramsOverride = override.params || {};
    const effective = {
      ...defaults,
      ...override,
      ...paramsOverride,
      params: undefined,
    };
    delete effective.params;

    if (effective.enabled === false) continue;
    configs[key] = { enabled: true, params: effective };
  }

  return configs;
}

function serializeEvidence(signal, filterReasons = []) {
  return {
    strategy: signal.strategy,
    direction: signal.signal,
    confidence: signal.confidence,
    reason: signal.reason,
    filter_reasons: filterReasons,
  };
}

function strategyKeys(signal) {
  return [
    signal.strategy,
    ...(Array.isArray(signal.contributingStrategies) ? signal.contributingStrategies : []),
  ].filter(Boolean);
}

function effectiveConfig(config, strategyConfigs, options) {
  return {
    strategies: strategyConfigs,
    signal_filter: {
      minConfidence: options.minConfidence,
      filterConflicts: options.filterConflicts,
      boostResonance: options.boostResonance,
      buyRequiresTrendConfirm: options.buyRequiresTrendConfirm,
    },
    profit_filter: options.profitFilter,
    trading_costs: {
      ...(config.TRADING_COSTS || {}),
      roundTripPercent: options.roundTripCostPercent,
    },
  };
}

export class SignalEngine {
  constructor({ config = CONFIG, versionOptions = {} } = {}) {
    this.config = config;
    this.versionOptions = versionOptions;
  }

  /**
   * Evaluate the last candle in a dataset. The last input candle must be
   * closed; unfinished REST candles are discarded before this method runs.
   */
  evaluate({
    symbol,
    timeframe = '1h',
    candles,
    indicators = null,
    now,
    strategyOverrides = {},
    minConfidence,
    filterConflicts,
    boostResonance,
    buyRequiresTrendConfirm,
    profitFilter,
    roundTripCostPercent,
    requireClosed = true,
    generatedAt,
  } = {}) {
    const normalizedInput = normalizeCandles(candles || [], {
      symbol,
      timeframe,
      now,
    });
    const normalizedCandles = filterClosedCandles(normalizedInput, { symbol, timeframe, now });
    const lastInput = normalizedInput.at(-1);

    if (!lastInput) {
      return {
        eligible: false,
        reason: 'NO_CLOSED_CANDLE',
        symbol,
        timeframe,
        candles: normalizedCandles,
        rawSignals: [],
        signals: [],
      };
    }

    if (requireClosed && lastInput.is_closed !== true) {
      return {
        eligible: false,
        reason: 'UNFINISHED_CANDLE',
        symbol,
        timeframe,
        candles: normalizedCandles,
        rawSignals: [],
        signals: [],
      };
    }

    const candle = normalizedCandles.at(-1);
    if (!candle) {
      return {
        eligible: false,
        reason: 'NO_CLOSED_CANDLE',
        symbol,
        timeframe,
        candles: normalizedCandles,
        rawSignals: [],
        signals: [],
      };
    }
    assertClosedCandle(candle);

    const effectiveMinConfidence = minConfidence
      ?? this.config.SIGNAL_FILTER?.minConfidence
      ?? 40;
    const effectiveFilterConflicts = filterConflicts
      ?? this.config.SIGNAL_FILTER?.filterConflicts !== false;
    const effectiveBoostResonance = boostResonance
      ?? this.config.SIGNAL_FILTER?.boostResonance !== false;
    const effectiveBuyTrendConfirm = buyRequiresTrendConfirm
      ?? this.config.SIGNAL_FILTER?.buyRequiresTrendConfirm !== false;
    const effectiveProfitFilter = profitFilter === undefined
      ? this.config.PROFIT_FILTER
      : profitFilter;
    const effectiveRoundTripCostPercent = roundTripCostPercent
      ?? this.config.TRADING_COSTS?.roundTripPercent
      ?? 0;
    const strategyConfigs = buildStrategyConfigs(this.config, strategyOverrides);
    const configForHash = effectiveConfig(this.config, strategyConfigs, {
      minConfidence: effectiveMinConfidence,
      filterConflicts: effectiveFilterConflicts,
      boostResonance: effectiveBoostResonance,
      buyRequiresTrendConfirm: effectiveBuyTrendConfirm,
      profitFilter: effectiveProfitFilter,
      roundTripCostPercent: effectiveRoundTripCostPercent,
    });
    const candleTimestamp = candleToIso(candle.close_time ?? candle.open_time);
    const evaluationTimestamp = generatedAt || new Date(now ?? Date.now()).toISOString();
    const computedIndicators = indicators || computeAllIndicators(normalizedCandles);

    if (!computedIndicators || computedIndicators.currentPrice === undefined) {
      return {
        eligible: false,
        reason: 'INSUFFICIENT_INDICATORS',
        symbol,
        timeframe,
        candle,
        candles: normalizedCandles,
        rawSignals: [],
        signals: [],
      };
    }

    const rawSignals = runStrategies(symbol, computedIndicators, strategyConfigs, {
      timestamp: candleTimestamp || evaluationTimestamp,
      timeframe,
      candle,
    });
    const qualitySignals = filterSignals(rawSignals, {
      minConfidence: effectiveMinConfidence,
      filterConflicts: effectiveFilterConflicts,
      boostResonance: effectiveBoostResonance,
      buyRequiresTrendConfirm: effectiveBuyTrendConfirm,
      trendIndicators: {
        sma_50: computedIndicators.sma_50,
        currentPrice: computedIndicators.currentPrice,
      },
    });
    const signals = applyProfitFilter(qualitySignals, {
      ...(effectiveProfitFilter || {}),
      roundTripCostPercent: effectiveRoundTripCostPercent,
    });
    const lineage = buildLineage(configForHash, {
      ...this.versionOptions,
      generatedAt: evaluationTimestamp,
      configHash: hashConfig(configForHash),
    });

    const qualityStrategies = new Set(qualitySignals.flatMap(strategyKeys));
    const acceptedStrategies = new Set(signals.flatMap(strategyKeys));
    const rejectedSignals = rawSignals.filter(raw => !acceptedStrategies.has(raw.strategy));
    const rawByStrategy = new Map(rawSignals.map(raw => [raw.strategy, raw]));

    const enrichedSignals = signals.map(signal => ({
      ...signal,
      ...lineage,
      candle_open_time: candleToIso(candle.open_time),
      candle_close_time: candleToIso(candle.close_time),
      timeframe,
      symbol,
      direction: signal.signal,
      raw_score: signal.raw_score ?? signal.score ?? signal.confidence,
      regime: signal.regime ?? null,
      volatility_regime: signal.volatility_regime ?? null,
      raw_features: computedIndicators,
      contributing_evidence: (signal.contributingStrategies || [signal.strategy]).map(strategy => {
        return serializeEvidence(rawByStrategy.get(strategy) || signal, []);
      }),
      rejected_evidence: rejectedSignals.map(rejected => serializeEvidence(
        rejected,
        [qualityStrategies.has(rejected.strategy) ? 'profit_filter' : 'quality_filter'],
      )),
      filter_reasons: [],
      signal_status: 'eligible',
      delivered_at: null,
      delivery_status: 'pending',
      entry_reference: signal.entry_reference ?? signal.suggestedEntry ?? computedIndicators.currentPrice,
      signal_timestamp: candleToIso(candle.close_time ?? candle.open_time),
    }));

    return {
      eligible: true,
      symbol,
      timeframe,
      candle,
      candles: normalizedCandles,
      indicators: computedIndicators,
      rawSignals,
      qualitySignals,
      rejectedSignals,
      signals: enrichedSignals,
      configHash: lineage.config_hash,
      effectiveConfig: configForHash,
    };
  }
}

export function evaluateSignals(options) {
  return new SignalEngine(options?.engineOptions).evaluate(options);
}

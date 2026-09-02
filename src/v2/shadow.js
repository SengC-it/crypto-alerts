// V2 shadow candidate construction. This module is deliberately not imported
// by the V1 live/serverless production entry points.

import { CONFIG, getIndicatorLookback } from '../config.js';
import { buildLineage, hashConfig } from '../lineage.js';
import { getIndicatorProvenance } from '../indicators/provenance.js';
import {
  V2_CONTEXT_TIMEFRAME,
  V2_TRIGGER_TIMEFRAME,
  aggregateClosedCandlesTo4h,
  canonicalClosedWindow,
  canonicalIndicators,
} from './canonical.js';
import { buildIndependentEvidence } from './evidence.js';
import { buildResearchBarriers } from './barriers.js';
import { groupMarketEvents, rankShadowCandidates, SHADOW_STATUS } from './marketEvents.js';
import { RegimeEngine } from './regime.js';
import { scoreCandidate } from './scoring.js';
import { eligibleSetups } from './setups.js';

export const V2_MODEL_VERSION = 'm1-v2-quality-0.1.0';
export const V2_SIGNAL_ENGINE_VERSION = 'm1.0.0-shadow';
export const V2_MODE = SHADOW_STATUS;

const V2_FLAGS = Object.freeze({
  V1_UNCHANGED: true,
  V2_SHADOW_ONLY: true,
  V2_PRODUCTION_ENABLED: false,
  AUTO_TRADING: false,
});

function shadowConfig(config, options) {
  return {
    trigger_timeframe: V2_TRIGGER_TIMEFRAME,
    context_timeframe: V2_CONTEXT_TIMEFRAME,
    indicator_lookback_candles: getIndicatorLookback(config, options),
    mode: V2_MODE,
    regime: options.regime || {},
    setups: options.setups || {},
    barriers: options.barriers || {},
    evidence_groups: options.evidenceGroups || [],
  };
}

/**
 * Build all eligible V2 setup candidates for one closed trigger candle.
 * `triggerCandles` is the only source of 1h history; no future rows are read.
 */
export function buildV2ShadowSignal({
  symbol,
  triggerCandles,
  contextCandles,
  asOf = Date.now(),
  config = CONFIG,
  lookbackCandles,
  regimeOptions = {},
  setupOptions = {},
  barrierOptions = {},
  publicData = {},
  calibration = null,
  lineageOptions = {},
} = {}) {
  const window = canonicalClosedWindow(triggerCandles, {
    symbol,
    timeframe: V2_TRIGGER_TIMEFRAME,
    asOf,
    config,
    lookbackCandles,
  });
  if (!window.eligible) {
    return {
      eligible: false,
      reason: window.reason,
      symbol,
      trigger_timeframe: V2_TRIGGER_TIMEFRAME,
      context_timeframe: V2_CONTEXT_TIMEFRAME,
      indicatorLookbackCandles: window.lookbackCandles,
      candidates: [],
      ...V2_FLAGS,
    };
  }

  const indicators = canonicalIndicators(window, {
    symbol,
    timeframe: V2_TRIGGER_TIMEFRAME,
    lookbackCandles: window.lookbackCandles,
  });
  const context = contextCandles?.length
    ? contextCandles
    : aggregateClosedCandlesTo4h(window.allClosedCandles, { symbol, asOf });
  const regime = new RegimeEngine(regimeOptions).classify({
    symbol,
    triggerCandles: window.allClosedCandles,
    contextCandles: context,
    asOf,
  });
  const setups = eligibleSetups(window.indicatorCandles, regime, setupOptions);
  const configForHash = shadowConfig(config, {
    ...lineageOptions,
    regime: regimeOptions,
    setups: setupOptions,
    barriers: barrierOptions,
    evidenceGroups: ['Trend', 'Momentum', 'Participation', 'Volatility', 'Market Structure', 'Higher Timeframe'],
    indicatorLookbackCandles: window.lookbackCandles,
  });
  const lineage = buildLineage(configForHash, {
    ...lineageOptions,
    modelVersion: lineageOptions.modelVersion || V2_MODEL_VERSION,
    signalEngineVersion: V2_SIGNAL_ENGINE_VERSION,
    configHash: hashConfig(configForHash),
    generatedAt: lineageOptions.generatedAt || new Date(asOf).toISOString(),
  });

  const candidates = setups.map(setup => {
    const evidence = buildIndependentEvidence({
      candles: window.indicatorCandles,
      indicators,
      regime,
      setup,
      publicData,
    });
    const score = scoreCandidate({ evidence, calibration });
    const barrier = buildResearchBarriers({
      direction: setup.direction,
      entryPrice: setup.entry_reference,
      candles: window.indicatorCandles,
      options: barrierOptions,
    });
    return {
      ...setup,
      ...lineage,
      ...score,
      symbol,
      timeframe: V2_TRIGGER_TIMEFRAME,
      trigger_timeframe: V2_TRIGGER_TIMEFRAME,
      context_timeframe: V2_CONTEXT_TIMEFRAME,
      trend_regime: regime.trend_regime,
      volatility_regime: regime.volatility_regime,
      regime,
      indicator_lookback_candles: window.lookbackCandles,
      indicator_window_start: window.indicatorCandles[0]?.open_time ?? null,
      indicator_window_end: window.indicatorCandles.at(-1)?.open_time ?? null,
      indicator_provenance: getIndicatorProvenance(indicators),
      raw_features: indicators,
      contributing_evidence: evidence.accepted,
      rejected_evidence: evidence.rejected,
      evidence_groups: evidence.groups_present,
      market_event_id: null,
      market_breadth: 1,
      same_direction_breadth: 1,
      cluster_size: 1,
      cluster_rank: 1,
      ranking_bucket: 'SHADOW',
      status: SHADOW_STATUS,
      shadow_status: SHADOW_STATUS,
      decision: SHADOW_STATUS,
      entry_reference: setup.entry_reference,
      direction: setup.direction,
      barrier,
      barrier_version: barrier.barrier_version,
      barrier_config_hash: barrier.barrier_config_hash,
      targetPrice: barrier.targetPrice,
      stopLoss: barrier.stopLoss,
      score_calibration_status: calibration?.status || 'CALIBRATION_PENDING',
      public_data_only: true,
      ...V2_FLAGS,
    };
  });

  return {
    eligible: true,
    reason: candidates.length ? null : 'NO_ELIGIBLE_SETUP',
    symbol,
    trigger_timeframe: V2_TRIGGER_TIMEFRAME,
    context_timeframe: V2_CONTEXT_TIMEFRAME,
    triggerCandle: window.triggerCandle,
    indicatorCandles: window.indicatorCandles,
    indicatorLookbackCandles: window.lookbackCandles,
    indicators,
    contextCandles: context,
    regime,
    setups,
    candidates,
    ...V2_FLAGS,
  };
}

/** Rank all candidates but retain every candidate as SHADOW for auditability. */
export function rankV2ShadowCandidates(candidates, options = {}) {
  return rankShadowCandidates(candidates, options);
}

export function summarizeMarketEvents(candidates, options = {}) {
  return groupMarketEvents(candidates, options).map(event => ({
    market_event_id: event.market_event_id,
    bucket: event.bucket,
    market_breadth: event.market_breadth,
    candidate_count: event.candidate_count,
    directions: event.directions,
  }));
}

export { V2_FLAGS };

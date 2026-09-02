// Reproducible M1 experiment runner. It consumes supplied historical candles
// and never writes to Supabase or calls a private exchange endpoint.

import { CONFIG, getIndicatorLookback } from '../config.js';
import { SignalEngine } from '../signal/engine.js';
import { SignalEvaluator, DEFAULT_HORIZONS_HOURS } from '../evaluation/signalEvaluator.js';
import { getCommitSha, hashConfig } from '../lineage.js';
import { filterClosedCandles } from '../market/candle.js';
import { groupMarketEvents } from './marketEvents.js';
import { compareV1V2 } from './comparator.js';
import { summarizeEvaluations, toEvaluationRecord } from './metrics.js';
import { evaluatePromotionGate } from './promotion.js';
import { rankV2ShadowCandidates, buildV2ShadowSignal } from './shadow.js';
import { buildScoreCalibration } from './scoring.js';
import {
  fitClusterSelectionPolicy,
  predictClusterSelections,
  runPurgedWalkForward,
} from './walkForward.js';

export const M1_HORIZONS_HOURS = Object.freeze([...DEFAULT_HORIZONS_HOURS]);

const HOUR = 60 * 60 * 1000;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function round(value, digits = 6) {
  return Number.isFinite(Number(value)) ? +Number(value).toFixed(digits) : null;
}

function coverageForCandles(candles, { symbol, dataSource }) {
  const sorted = [...candles].sort((a, b) => a.open_time - b.open_time);
  const first = sorted[0]?.open_time ?? null;
  const last = sorted.at(-1)?.open_time ?? null;
  const expected = first === null || last === null ? 0 : Math.floor((last - first) / HOUR) + 1;
  const unique = new Set(sorted.map(candle => candle.open_time));
  const loaded = [...unique].filter(value => value >= first && value <= last).length;
  return {
    symbol,
    data_source: dataSource,
    timeframe: '1h',
    requested_start: first,
    requested_end: last,
    actual_start: first,
    actual_end: sorted.at(-1)?.close_time ?? null,
    candles_expected: expected,
    candles_loaded: loaded,
    missing_candles: Math.max(0, expected - loaded),
    coverage_percent: expected ? round(loaded / expected * 100, 4) : 0,
  };
}

function attachV1MarketEvents(signals) {
  const events = groupMarketEvents(signals);
  const byIndex = new Map();
  for (const event of events) {
    for (const member of event.members) {
      byIndex.set(member.index, {
        market_event_id: event.market_event_id,
        market_breadth: event.market_breadth,
        same_direction_breadth: event.directions[String(member.candidate.direction ?? member.candidate.signal).toUpperCase()] || 0,
      });
    }
  }
  return signals.map((signal, index) => ({ ...signal, ...(byIndex.get(index) || {}) }));
}

function buildBenchmark({ symbols, candlesBySymbol, asOf, roundTripCostPercent, dataSource }) {
  const allCandles = Object.values(candlesBySymbol).flat();
  const sorted = allCandles.sort((a, b) => a.open_time - b.open_time);
  return {
    symbols: [...symbols].sort(),
    candles: {
      timeframe: '1h',
      closed_only: true,
      per_symbol_count: Object.fromEntries(symbols.map(symbol => [symbol, candlesBySymbol[symbol].length])),
    },
    evaluation_horizons: [...M1_HORIZONS_HOURS],
    fees: { round_trip_percent: roundTripCostPercent },
    slippage: { included_in_round_trip_cost: true },
    market_event_window_hours: 4,
    date_range: {
      start: sorted[0]?.open_time ?? null,
      end: sorted.at(-1)?.close_time ?? null,
      as_of: asOf,
    },
    data_source: dataSource,
    account_return_claim: false,
  };
}

function chooseWalkForwardOptions(sampleCount, requested = {}) {
  const developmentCount = Math.floor(sampleCount * 0.8);
  // Fixed rolling proportions leave room for at least six OOS windows on a
  // sufficiently long history; they are protocol settings, not tuned gates.
  const trainSize = requested.trainSize || Math.max(60, Math.floor(developmentCount * 0.35));
  const testSize = requested.testSize || Math.max(12, Math.floor(developmentCount * 0.06));
  return {
    trainSize,
    testSize,
    step: requested.step || testSize,
    finalHoldoutCount: requested.finalHoldoutCount || Math.max(12, Math.floor(sampleCount * 0.2)),
    purgeHours: requested.purgeHours ?? 48,
    embargoHours: requested.embargoHours ?? 24,
    labelHorizonHours: requested.labelHorizonHours ?? 48,
    minimumTrainSamples: requested.minimumTrainSamples || Math.max(10, Math.floor(trainSize * 0.35)),
    minimumWindows: requested.minimumWindows || 6,
  };
}

function buildOosSamples(records, options = {}) {
  const samples = records.map((record, index) => {
    const signal = record.signal || {};
    const signalTime = finite(record.signal?.trigger_time ?? record.evaluation?.signal_timestamp);
    const outcome = finite(record.evaluation?.net_forward_returns?.['1h']);
    return {
      record_index: index,
      timestamp: signalTime,
      label_end_time: signalTime === null ? null : signalTime + (options.labelHorizonHours ?? 48) * HOUR,
      market_event_id: record.market_event_id ?? signal.market_event_id ?? null,
      symbol: record.symbol ?? signal.symbol ?? null,
      direction: record.direction ?? signal.direction ?? signal.signal ?? null,
      setup_family: record.setup_family ?? signal.setup_family ?? null,
      cluster_rank: signal.cluster_rank ?? record.cluster_rank ?? null,
      ranking_bucket: signal.ranking_bucket ?? record.ranking_bucket ?? null,
      raw_score: record.raw_score ?? signal.raw_score,
      edge_score: record.edge_score ?? signal.edge_score,
      volatility_regime: record.volatility_regime ?? signal.volatility_regime ?? null,
      trend_regime: record.trend_regime ?? signal.trend_regime ?? null,
      outcome,
      gross_return_percent: finite(record.evaluation?.forward_returns?.['1h']),
      mfe_percent: finite(record.evaluation?.mfe_percent),
      mae_percent: finite(record.evaluation?.mae_percent),
    };
  }).filter(sample => sample.timestamp !== null && sample.outcome !== null);
  return samples;
}

function recordTimestamp(record) {
  const value = record?.signal?.trigger_time
    ?? record?.signal?.signal_timestamp
    ?? record?.evaluation?.signal_timestamp
    ?? record?.signal_timestamp;
  if (Number.isFinite(Number(value))) return Number(value);
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function recordsWithinWalkForwardWindows(records, walkForward) {
  const windows = (walkForward?.windows || [])
    .map(window => ({
      start: finite(window.test_start),
      end: finite(window.test_end),
    }))
    .filter(window => window.start !== null && window.end !== null);
  if (!windows.length) return [];
  return records.filter(record => {
    const timestamp = recordTimestamp(record);
    return timestamp !== null && windows.some(window => timestamp >= window.start && timestamp <= window.end);
  });
}

function oosRecordsBySelection(records, walkForward, predicate = () => true) {
  const seen = new Set();
  return (walkForward.oos_samples || [])
    .filter(predicate)
    .map(item => records[item.record_index ?? item.sample?.record_index ?? item.sample_index])
    .filter(record => {
      const index = records.indexOf(record);
      if (!record || seen.has(index)) return false;
      seen.add(index);
      return true;
    });
}

function selectedOosRecords(records, walkForward) {
  return oosRecordsBySelection(records, walkForward, item => item.selected === true);
}

function compactHistoricalCandidate(candidate) {
  return {
    symbol: candidate.symbol,
    direction: candidate.direction,
    setup_family: candidate.setup_family,
    reason: candidate.reason,
    signal_index: candidate.signal_index,
    label_end_time: candidate.label_end_time,
    trigger_time: candidate.trigger_time,
    trigger_open_time: candidate.trigger_open_time,
    timeframe: candidate.timeframe,
    trigger_timeframe: candidate.trigger_timeframe,
    context_timeframe: candidate.context_timeframe,
    trend_regime: candidate.trend_regime,
    volatility_regime: candidate.volatility_regime,
    regime: candidate.regime
      ? {
        trend_regime: candidate.regime.trend_regime,
        volatility_regime: candidate.regime.volatility_regime,
        context_time: candidate.regime.context_time,
        trigger_time: candidate.regime.trigger_time,
      }
      : null,
    raw_score: candidate.raw_score,
    edge_score: candidate.edge_score,
    score_semantics: candidate.score_semantics,
    evidence_group_count: candidate.evidence_group_count,
    indicator_lookback_candles: candidate.indicator_lookback_candles,
    indicator_window_start: candidate.indicator_window_start,
    indicator_window_end: candidate.indicator_window_end,
    market_event_id: candidate.market_event_id,
    market_breadth: candidate.market_breadth,
    same_direction_breadth: candidate.same_direction_breadth,
    cluster_size: candidate.cluster_size,
    cluster_rank: candidate.cluster_rank,
    ranking_bucket: candidate.ranking_bucket,
    status: candidate.status,
    shadow_status: candidate.shadow_status,
    decision: candidate.decision,
    entry_reference: candidate.entry_reference,
    barrier: candidate.barrier,
    barrier_version: candidate.barrier_version,
    barrier_config_hash: candidate.barrier_config_hash,
    targetPrice: candidate.targetPrice,
    stopLoss: candidate.stopLoss,
    model_version: candidate.model_version,
    signal_engine_version: candidate.signal_engine_version,
    public_data_only: candidate.public_data_only,
    V1_UNCHANGED: candidate.V1_UNCHANGED,
    V2_SHADOW_ONLY: candidate.V2_SHADOW_ONLY,
    AUTO_TRADING: candidate.AUTO_TRADING,
  };
}

function compactOosSelection(item) {
  return {
    market_event_id: item.market_event_id,
    symbol: item.symbol,
    direction: item.direction,
    setup_family: item.setup_family,
    cluster_rank: item.cluster_rank,
    ranking_bucket: item.ranking_bucket,
    raw_score: item.raw_score,
    edge_score: item.edge_score,
    timestamp: item.timestamp,
    outcome: item.outcome,
    raw_score_eligible: item.raw_score_eligible ?? null,
    score_eligible: item.score_eligible ?? null,
    volatility_eligible: item.volatility_eligible ?? null,
    oos_cluster_rank: item.oos_cluster_rank ?? null,
    selection_status: item.selection_status ?? null,
    selected: item.selected === true,
    window_index: item.window_index ?? null,
  };
}

function generateSignalsForSymbol(symbol, candles, {
  config,
  contextCandles,
  asOf,
  lookbackCandles,
  regimeOptions,
  setupOptions,
  barrierOptions,
  lineageOptions,
  retainArtifacts = true,
} = {}) {
  const closed = filterClosedCandles(candles, { symbol, timeframe: '1h', now: asOf });
  const v2Candidates = [];
  const v1Signals = [];
  const v1Engine = new SignalEngine({ config });
  const minimum = lookbackCandles;
  for (let index = minimum - 1; index < closed.length; index++) {
    const current = closed[index];
    const currentAsOf = current.close_time + 1;
    const prefix = closed.slice(0, index + 1);
    const v2 = buildV2ShadowSignal({
      symbol,
      triggerCandles: prefix,
      contextCandles,
      asOf: currentAsOf,
      config,
      lookbackCandles,
      regimeOptions,
      setupOptions,
      barrierOptions,
      lineageOptions: {
        ...lineageOptions,
        generatedAt: new Date(currentAsOf).toISOString(),
      },
    });
    v2Candidates.push(...v2.candidates.map(candidate => ({
      ...candidate,
      signal_index: index,
      label_end_time: current.close_time + 48 * HOUR,
    })).map(candidate => retainArtifacts ? candidate : compactHistoricalCandidate(candidate)));

    const v1 = v1Engine.evaluate({
      symbol,
      timeframe: '1h',
      candles: prefix,
      now: currentAsOf,
      generatedAt: new Date(currentAsOf).toISOString(),
    });
    v1Signals.push(...(v1.signals || []).map(signal => ({
      ...signal,
      signal_index: index,
      label_end_time: current.close_time + 48 * HOUR,
    })));
  }
  return { closed, v2Candidates, v1Signals };
}

export function runM1Experiment({
  candlesBySymbol = {},
  contextBySymbol = {},
  config = CONFIG,
  asOf = Date.now(),
  dataSource = 'provided_historical_data',
  experimentId = null,
  roundTripCostPercent = config.TRADING_COSTS?.roundTripPercent ?? 0.14,
  regimeOptions = {},
  setupOptions = {},
  barrierOptions = {},
  walkForwardOptions = {},
  lineageOptions = {},
  includeArtifacts = true,
} = {}) {
  const symbols = Object.keys(candlesBySymbol).sort();
  const lookbackCandles = getIndicatorLookback(config);
  const normalizedBySymbol = Object.fromEntries(symbols.map(symbol => [
    symbol,
    filterClosedCandles(candlesBySymbol[symbol], { symbol, timeframe: '1h', now: asOf }),
  ]));
  const coverage = symbols.map(symbol => coverageForCandles(normalizedBySymbol[symbol], { symbol, dataSource }));
  const benchmark = buildBenchmark({
    symbols,
    candlesBySymbol: normalizedBySymbol,
    asOf,
    roundTripCostPercent,
    dataSource,
  });

  const allV2Candidates = [];
  const allV1Signals = [];
  for (const symbol of symbols) {
    const generated = generateSignalsForSymbol(symbol, normalizedBySymbol[symbol], {
      config,
      contextCandles: contextBySymbol[symbol],
      asOf,
      lookbackCandles,
      regimeOptions,
      setupOptions,
      barrierOptions,
      lineageOptions,
      retainArtifacts: includeArtifacts,
    });
    allV2Candidates.push(...generated.v2Candidates);
    allV1Signals.push(...generated.v1Signals);
  }

  const rankedV2 = rankV2ShadowCandidates(allV2Candidates);
  const v1WithEvents = attachV1MarketEvents(allV1Signals);
  const evaluator = new SignalEvaluator({
    roundTripCostPercent,
    horizons: M1_HORIZONS_HOURS,
  });
  const v2Records = [];
  for (const candidate of rankedV2) {
    const candles = normalizedBySymbol[candidate.symbol] || [];
    const evaluation = evaluator.evaluate(candidate, candles, { signalIndex: candidate.signal_index });
    v2Records.push(toEvaluationRecord(candidate, evaluation));
  }
  const v1Records = [];
  for (const signal of v1WithEvents) {
    const candles = normalizedBySymbol[signal.symbol] || [];
    const evaluation = evaluator.evaluate(signal, candles, { signalIndex: signal.signal_index });
    v1Records.push(toEvaluationRecord(signal, evaluation));
  }

  const walkForwardSeed = buildOosSamples(v2Records, walkForwardOptions);
  const walkForwardPlanOptions = chooseWalkForwardOptions(walkForwardSeed.length, walkForwardOptions);
  const walkForward = runPurgedWalkForward(walkForwardSeed, {
    ...walkForwardPlanOptions,
    ...walkForwardOptions,
    fit: trainSamples => fitClusterSelectionPolicy(trainSamples, {
      ...walkForwardOptions,
      clusterTopN: walkForwardOptions.clusterTopN ?? 1,
    }),
    predict: (testSamples, model) => predictClusterSelections(testSamples, model, {
      clusterTopN: model.cluster_top_n,
    }),
  });
  const oosAllRecords = oosRecordsBySelection(v2Records, walkForward);
  const oosScoreEligibleRecords = oosRecordsBySelection(
    v2Records,
    walkForward,
    item => item.score_eligible === true,
  );
  const oosRecords = selectedOosRecords(v2Records, walkForward);
  const v2Metrics = summarizeEvaluations(oosRecords, { horizons: M1_HORIZONS_HOURS });
  const v1OosRecords = recordsWithinWalkForwardWindows(v1Records, walkForward);
  const v1Metrics = summarizeEvaluations(v1OosRecords, { horizons: M1_HORIZONS_HOURS });
  const oosEventIds = new Set(oosAllRecords.map(record => record.market_event_id).filter(Boolean));
  const selection = {
    all_candidates: rankedV2.length,
    score_eligible_candidates: oosScoreEligibleRecords.length,
    cluster_selected_candidates: oosRecords.length,
    independent_market_events: oosEventIds.size,
    oos: {
      all_candidates: oosAllRecords.length,
      score_eligible_candidates: oosScoreEligibleRecords.length,
      cluster_selected_candidates: oosRecords.length,
      independent_market_events: oosEventIds.size,
    },
  };
  const comparison = compareV1V2({
    benchmark,
    v1Records: v1OosRecords,
    v2Records: oosRecords,
    selection,
  });
  const calibration = buildScoreCalibration(
    oosRecords.map(record => ({
      raw_score: record.raw_score,
      outcome: record.evaluation?.net_forward_returns?.['1h'],
      gross_return_percent: record.evaluation?.forward_returns?.['1h'],
      mfe_percent: record.evaluation?.mfe_percent,
      mae_percent: record.evaluation?.mae_percent,
    })),
  );
  const promotion = evaluatePromotionGate({
    metrics: { ...v2Metrics, score_calibration: calibration },
    walkForward,
    calibration,
    dataSource,
  });
  const defaultId = `m1-${new Date(benchmark.date_range.start || asOf).toISOString().slice(0, 10)}-${lookbackCandles}`;
  const commitSha = lineageOptions.commitSha || getCommitSha();
  const configHash = hashConfig({
    config,
    model_version: lineageOptions.modelVersion || 'm1-v2-quality-0.1.0',
    regime_options: regimeOptions,
    setup_options: setupOptions,
    barrier_options: barrierOptions,
    walk_forward_options: walkForwardPlanOptions,
  });
  const researchArtifact = {
    experiment_id: experimentId || defaultId,
    model_version: lineageOptions.modelVersion || 'm1-v2-quality-0.1.0',
    commit_sha: commitSha,
    config_hash: configHash,
    data_source: benchmark.data_source,
    exact_date_range: benchmark.date_range,
    symbols: benchmark.symbols,
    coverage,
    cost_assumptions: {
      fees: benchmark.fees,
      slippage: benchmark.slippage,
    },
    wfo: {
      options: walkForward.options,
      window_boundaries: walkForward.windows.map(window => ({
        index: window.index,
        train_start: window.train_start,
        train_end: window.train_end,
        test_start: window.test_start,
        test_end: window.test_end,
        purge_hours: window.purge_hours,
        embargo_hours: window.embargo_hours,
      })),
      final_holdout_boundary: walkForward.final_holdout_boundary,
      final_holdout_hash: walkForward.final_holdout_hash,
      per_window_trained_policy_summary: walkForward.trained_policy_summary,
    },
  };

  return {
    experiment_id: experimentId || defaultId,
    model_version: lineageOptions.modelVersion || 'm1-v2-quality-0.1.0',
    commit_sha: commitSha,
    config_hash: configHash,
    mode: 'SHADOW_ONLY',
    flags: {
      V1_UNCHANGED: true,
      V2_SHADOW_ONLY: true,
      V2_PRODUCTION_ENABLED: false,
      AUTO_TRADING: false,
    },
    benchmark,
    historical_coverage: {
      complete: coverage.every(item => item.missing_candles === 0),
      per_symbol: coverage,
      minimum_coverage_percent: coverage.length ? Math.min(...coverage.map(item => item.coverage_percent)) : 0,
    },
    candidate_count: rankedV2.length,
    selection,
    candidates: includeArtifacts ? rankedV2 : [],
    market_events: [...new Set(rankedV2.map(candidate => candidate.market_event_id).filter(Boolean))].length,
    v2_record_count: v2Records.length,
    v1_record_count: v1OosRecords.length,
    v1_full_record_count: v1Records.length,
    oos_record_count: oosRecords.length,
    oos_all_record_count: oosAllRecords.length,
    oos_score_eligible_count: oosScoreEligibleRecords.length,
    oos_cluster_selected_count: oosRecords.length,
    v2_records: includeArtifacts ? v2Records : [],
    v1_records: includeArtifacts ? v1Records : [],
    oos_records: includeArtifacts ? oosRecords : [],
    walk_forward: includeArtifacts
      ? walkForward
      : {
        ...walkForward,
        windows: walkForward.windows.map(({ train, test, ...window }) => window),
        oos_samples: walkForward.oos_samples.map(compactOosSelection),
      },
    metrics: {
      v2: v2Metrics,
      v1: v1Metrics,
    },
    comparison,
    calibration,
    promotion,
    research_artifact: researchArtifact,
  };
}

// Run the bounded M1.3 cross-sectional / relative-value research program.
// This script is public-data-only, research-only and never changes production
// V1/V2 behavior, deployment state or exchange orders.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { getCommitSha, hashConfig } from '../src/lineage.js';
import { loadBinanceVisionCandlesLongRange } from '../src/backtest/binanceArchive.js';
import { CoverageError, loadBacktestHistory, requestedWindow } from '../src/backtest/history.js';
import { generateHistoricalResearchRecords } from '../src/v2/experiment.js';
import {
  M1_FROZEN_HOLDOUT,
  prepareM11Samples,
  freezeM1DevelopmentRecords,
  runM11Candidate,
} from '../src/v2/edgeDiscovery.js';
import {
  M12_BASELINE_CANDIDATE,
  runM12Candidate,
} from '../src/v2/informationGain.js';
import {
  M12_DERIVATIVE_FAMILIES,
  M12_MAX_STALE_MS,
  M12_MIN_COVERAGE,
  attachPointInTimeDerivativeFeatures,
  buildDataAdmissionReport,
} from '../src/v2/microstructureFeatures.js';
import { loadPublicDerivativeHistory } from '../src/v2/derivativesData.js';
import {
  M13_BETA_WINDOW_HOURS,
  M13_BOOTSTRAP_REPETITIONS,
  M13_BOOTSTRAP_SEED,
  M13_CANDIDATE_BUDGET,
  M13_COST_SENSITIVITY_PERCENT,
  M13_FEATURE_VERSION,
  M13_HORIZONS_HOURS,
  M13_INDEPENDENT_EVENT_DEFINITION,
  M13_MIN_VALID_SYMBOLS,
  M13_MODEL_VERSION,
  M13_PREDECLARED_CANDIDATES,
  M13_PROMOTION_THRESHOLDS,
  M13_ROUND_TRIP_COST_PERCENT,
  M13_SAFETY_FLAGS,
  assertM13ComparatorParity,
  attachCrossSectionalDerivativeRanks,
  buildCrossSectionSnapshots,
  buildCrossSectionalFeatures,
  buildDirectionalSamples,
  buildFactorCorrelationDiagnostics,
  buildM13StabilityDiagnostics,
  calculateM13Concentration,
  compareM13Results,
  decideM13,
  evaluateAbsolutePromotionGate,
  evaluateIncrementalInformationGain,
  independentMarketEventId,
  m13CandidateConfigHash,
  runM13Candidate,
  scoreCrossSectionalCandidate,
  summarizeM13Candidate,
  summarizeM13Records,
} from '../src/v2/crossSectional.js';
import { buildM13Markdown } from '../src/v2/m13Report.js';
import { buildCanonicalWfoPlan } from '../src/v2/walkForward.js';

const HOUR = 60 * 60 * 1000;
const PREVIOUS_FINAL_HOLDOUT_BOUNDARY = 1783861199999;
const PREVIOUS_FINAL_HOLDOUT_HASH = '294e6cecb24eeb4ac5041d0bba74e0e0e04301092c13e0c454d862dcaafd40bb';
// Frozen from the completed M1.3 run. This is metadata only; no holdout
// outcomes are read when reconstructing the canonical calendar.
const FROZEN_M13_FINAL_HOLDOUT_START = 1777409999999;
const BASE_MAIN_SHA = '6dfccf25ff8b0db4365927b4f2709a9c79cd0dde';
const CLOSEOUT_PR = 4;
const GENERATION_HISTORY_CANDLES = 256;
const REQUIRED_X11_DERIVATIVE_FAMILIES = [...M12_DERIVATIVE_FAMILIES];

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function iso(value) {
  const timestamp = finite(value);
  if (timestamp === null) return null;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function exactConfiguredSymbols(value) {
  const symbols = (value || CONFIG.BINANCE_SYMBOLS.join(','))
    .split(',')
    .map(symbol => symbol.toUpperCase().trim())
    .filter(Boolean);
  const configured = [...CONFIG.BINANCE_SYMBOLS].map(symbol => symbol.toUpperCase()).sort();
  if (symbols.length !== configured.length
    || [...symbols].sort().some((symbol, index) => symbol !== configured[index])) {
    throw new Error('M1.3 requires the configured 18-symbol universe without substitutions');
  }
  return symbols;
}

function sourceReachable(sourceSha) {
  if (!sourceSha || sourceSha === 'unknown') return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceSha}^{commit}`], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

async function fetchPublicArchive(url) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetch(url, { signal: controller.signal });
      if (response.status === 404) return response;
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === maxRetries) return response;
        throw new Error(`retryable_http_${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(2000, 250 * 2 ** attempt)));
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`Public archive request failed: ${url}`);
}

function fixtureCandles(symbol, symbolIndex, startTime, count) {
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.floor(index / 240) % 3;
    const slope = cycle === 0 ? 0.0008 : cycle === 1 ? -0.0007 : 0.0001;
    const close = Math.max(1, 100 + symbolIndex * 0.4 + slope * index + Math.sin(index / 9 + symbolIndex) * 2);
    const previous = index ? 100 + symbolIndex * 0.4 + slope * (index - 1) + Math.sin((index - 1) / 9 + symbolIndex) * 2 : close;
    return {
      symbol,
      open: previous,
      high: Math.max(previous, close) + 0.8,
      low: Math.min(previous, close) - 0.8,
      close,
      volume: 1000 + symbolIndex * 10 + index % 17 * 25,
      quote_volume: close * (1000 + symbolIndex * 10 + index % 17 * 25),
      taker_buy_volume: 510 + index % 9,
      open_time: startTime + index * HOUR,
      close_time: startTime + (index + 1) * HOUR - 1,
      timeframe: '1h',
      is_closed: true,
    };
  });
}

async function loadResearchHistory(symbols, days, asOf, concurrency, symbolConcurrency, fixture = false) {
  const window = requestedWindow(days, { asOf, timeframe: '1h' });
  const warmup = getIndicatorLookback(CONFIG) + M13_BETA_WINDOW_HOURS + 48;
  const archiveStart = window.startOpen - warmup * HOUR;
  const histories = [];
  const batchSize = Math.max(1, symbolConcurrency);
  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async (symbol, batchIndex) => {
      const archive = fixture
        ? { candles: fixtureCandles(symbol, index + batchIndex, archiveStart, window.expected + warmup + 1), archive_months: [], monthly_archive_months: [], daily_fallback_dates: [], missing_archive_dates: [] }
        : await loadBinanceVisionCandlesLongRange({
          symbol,
          timeframe: '1h',
          startTime: archiveStart,
          endTime: window.requestedEnd,
          concurrency,
          fetchImpl: fetchPublicArchive,
        });
      const history = await loadBacktestHistory(symbol, days, {
        config: CONFIG,
        asOf,
        strictCoverage: true,
        candles: archive.candles,
      });
      return {
        symbol,
        candles: history.candles,
        researchCandles: archive.candles,
        coverage: { symbol, ...history.coverage },
        archive: {
          archive_months: archive.archive_months,
          monthly_archive_months: archive.monthly_archive_months,
          daily_fallback_dates: archive.daily_fallback_dates,
          missing_archive_dates: archive.missing_archive_dates,
        },
      };
    }));
    histories.push(...results);
  }
  return { window, histories };
}

async function loadWithMinimumCoverage(symbols, requestedDays, asOf, concurrency, symbolConcurrency, fixture) {
  try {
    return await loadResearchHistory(symbols, requestedDays, asOf, concurrency, symbolConcurrency, fixture);
  } catch (error) {
    if (requestedDays <= 180 || !(error instanceof CoverageError || error?.name === 'CoverageError')) throw error;
    console.log(JSON.stringify({ coverage_fallback: true, requested_days: requestedDays, accepted_days: 180, reason: error.message }));
    return loadResearchHistory(symbols, 180, asOf, concurrency, symbolConcurrency, fixture);
  }
}

function inResearchRange(record, window) {
  const timestamp = finite(record?.timestamp);
  return timestamp !== null
    && timestamp >= window.startOpen
    && timestamp + 48 * HOUR <= window.requestedEnd;
}

function eventDecorate(record) {
  const timestamp = finite(record.timestamp);
  const openTime = timestamp === null ? null : timestamp - HOUR + 1;
  const eventId = independentMarketEventId(openTime);
  return {
    ...record,
    snapshot_event_id: timestamp === null ? null : `m13-snapshot:${timestamp}`,
    independent_market_event_id: eventId,
    market_event_id: eventId,
  };
}

function compactWfo(result) {
  const walkForward = result?.walk_forward || {};
  const options = walkForward.options || {};
  return {
    canonical_wfo: options.canonical_wfo === true,
    canonical_wfo_version: options.canonical_wfo_version || null,
    canonical_plan_hash: options.canonical_plan_hash || null,
    canonical_clock_unit: options.canonical_clock_unit || null,
    canonical_clock_event_count: options.canonical_clock_event_count || null,
    options,
    window_count: walkForward.window_count || 0,
    windows: (walkForward.windows || []).map(window => ({
      index: window.index,
      train_start: window.train_start_timestamp ?? window.train_start ?? null,
      train_end: window.train_end_timestamp ?? window.train_end ?? null,
      purge_start: window.purge_start_timestamp ?? window.purge_start ?? null,
      purge_end: window.purge_end_timestamp ?? window.purge_end ?? null,
      test_start: window.test_start_timestamp ?? window.test_start ?? null,
      test_end: window.test_end_timestamp ?? window.test_end ?? null,
      embargo_start: window.embargo_start_timestamp ?? window.embargo_start ?? null,
      embargo_end: window.embargo_end_timestamp ?? window.embargo_end ?? null,
      embargo_boundary: window.embargo_boundary_timestamp ?? null,
      final_holdout_start: window.final_holdout_start_timestamp
        ?? window.final_holdout_start
        ?? null,
      purge_hours: window.purge_hours,
      embargo_hours: window.embargo_hours,
      train_event_count: window.train_event_count ?? null,
      test_event_count: window.test_event_count ?? null,
      train_sample_count: window.train_sample_count ?? null,
      test_sample_count: window.test_sample_count ?? null,
      purged_count: window.purged_count ?? window.purged_event_count ?? null,
      embargoed_count: window.embargoed_count ?? window.embargoed_event_count ?? null,
    })),
    final_holdout_count: walkForward.final_holdout_count || 0,
    final_holdout_start: walkForward.final_holdout_start_timestamp
      ?? walkForward.final_holdout_start
      ?? null,
    final_holdout_event_count: walkForward.final_holdout_event_count || null,
    final_holdout_hash: walkForward.final_holdout_hash || null,
    final_holdout_untouched: result?.final_holdout_untouched === true,
  };
}

function compactComparison(comparison) {
  if (!comparison) return null;
  const pairedEventIds = comparison.paired_event_ids || [];
  const pairedOutcomes = comparison.paired_event_outcomes || [];
  return {
    common_support_record_count: comparison.common_support_record_count ?? 0,
    common_support_event_count: comparison.common_support_event_count ?? 0,
    paired_independent_market_events: comparison.paired_independent_market_events ?? 0,
    paired_event_ids_count: pairedEventIds.length,
    paired_event_ids_hash: hashConfig(pairedEventIds),
    paired_event_outcomes_count: pairedOutcomes.length,
    paired_event_outcomes_hash: hashConfig(pairedOutcomes),
    point_estimate: comparison.point_estimate || null,
    bootstrap: comparison.bootstrap || null,
    common_support_comparison: comparison.common_support_comparison || null,
  };
}

function compactGate(gate) {
  if (!gate) return null;
  return {
    ...gate,
    comparison: compactComparison(gate.comparison),
  };
}

function compactCandidateSummary(summary) {
  if (!summary) return null;
  return {
    candidate_id: summary.candidate_id,
    family: summary.family,
    direction: summary.direction,
    primary_horizon_hours: summary.primary_horizon_hours,
    status: summary.status,
    independent_generator: summary.independent_generator,
    metrics: summary.metrics,
    all_oos_metrics: summary.all_oos_metrics,
    selection: summary.selection,
    per_window: summary.per_window || [],
    stability: summary.stability,
    concentration: summary.concentration,
    calibration: summary.calibration,
    incremental_gate: compactGate(summary.incremental_gate),
    absolute_gate: compactGate(summary.absolute_gate),
    comparison: compactComparison(summary.comparison),
    comparator_results: Object.fromEntries(Object.entries(summary.comparator_results || {}).map(([key, value]) => [
      key,
      compactComparison(value),
    ])),
    train_only: summary.train_only,
    point_in_time_features: summary.point_in_time_features,
    final_holdout_untouched: summary.final_holdout_untouched,
  };
}

function resultForM13Summary(result, candidate) {
  if (!result) return null;
  const records = (result.oos_records || []).map(record => ({
    ...record,
    primary_horizon_hours: candidate.primary_horizon_hours || 8,
    primary_outcome: finite(record.net_forward_returns?.[`${candidate.primary_horizon_hours || 8}h`]),
    primary_gross_outcome_percent: finite(record.forward_returns?.[`${candidate.primary_horizon_hours || 8}h`]),
    independent_market_event_id: record.independent_market_event_id || record.market_event_id,
    market_event_id: record.independent_market_event_id || record.market_event_id,
    snapshot_event_id: record.snapshot_event_id || (record.timestamp === null ? null : `m13-snapshot:${record.timestamp}`),
  }));
  const selected = records.filter(record => record.selected === true);
  const metrics = summarizeM13Records(selected, { primaryHorizonHours: candidate.primary_horizon_hours || 8 });
  return {
    ...result,
    candidate_id: candidate.candidate_id,
    candidate: { ...candidate, config_hash: result.config_hash },
    oos_records: records,
    selected_records: selected,
    metrics,
    all_oos_metrics: summarizeM13Records(records.map(record => ({ ...record, selected: true })), { primaryHorizonHours: candidate.primary_horizon_hours || 8 }),
    concentration: calculateM13Concentration(selected),
    calibration: metrics.score_calibration,
    feature_version: M13_FEATURE_VERSION,
  };
}

function buildV1Comparator(v1Records, bestResult, window) {
  const records = v1Records
    .filter(record => inResearchRange(record, window))
    .map(eventDecorate)
    .map(record => ({
      ...record,
      selected: true,
      primary_horizon_hours: 8,
      primary_outcome: finite(record.net_forward_returns?.['8h']),
      primary_gross_outcome_percent: finite(record.forward_returns?.['8h']),
    }));
  const metrics = summarizeM13Records(records, { primaryHorizonHours: 8 });
  return {
    candidate_id: 'V1-production-comparator',
    candidate: { candidate_id: 'V1-production-comparator', primary_horizon_hours: 8 },
    oos_records: records,
    selected_records: records,
    metrics,
    stability: { positive_window_ratio: null },
    concentration: calculateM13Concentration(records),
    walk_forward: bestResult?.walk_forward || { options: null },
    final_holdout_untouched: bestResult?.final_holdout_untouched === true,
  };
}

function repriceSamples(baseSamples, candidate) {
  const primaryHorizon = candidate.primary_horizon_hours || 8;
  return baseSamples.map(sample => {
    const score = scoreCrossSectionalCandidate(sample.feature_snapshot || sample, candidate, sample.direction);
    return {
      ...sample,
      candidate_id: candidate.candidate_id,
      raw_score: score.raw_score,
      edge_score: score.edge_score,
      signal_value: score.signal_value,
      signed_signal_value: score.signed_signal_value,
      primary_horizon_hours: primaryHorizon,
      primary_outcome: finite(sample.net_forward_returns?.[`${primaryHorizon}h`]),
      primary_gross_outcome_percent: finite(sample.forward_returns?.[`${primaryHorizon}h`]),
      derivative_rank_signal: sample.derivative_rank_signal ?? null,
    };
  });
}

function costSensitivity(result) {
  return M13_COST_SENSITIVITY_PERCENT.map(cost => {
    const selected = result?.selected_records || [];
    const gross = selected.map(record => finite(record.primary_gross_outcome_percent)).filter(value => value !== null);
    const net = gross.map(value => value - cost);
    const wins = net.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
    const losses = Math.abs(net.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
    return {
      round_trip_cost_percent: cost,
      selected_signals: selected.length,
      gross_expectancy_percent: round(gross.length ? gross.reduce((sum, value) => sum + value, 0) / gross.length : null),
      net_expectancy_percent: round(net.length ? net.reduce((sum, value) => sum + value, 0) / net.length : null),
      net_profit_factor: losses ? round(wins / losses, 6) : wins > 0 ? 999 : 0,
      selection_use: 'diagnostic_only; not used for candidate selection',
    };
  });
}

const requestedDaysArgument = Number(argument('days', '365'));
if (!Number.isFinite(requestedDaysArgument) || requestedDaysArgument < 180) {
  throw new Error(`M1.3 requires a target of 365d and an accepted minimum of 180d; received ${requestedDaysArgument}`);
}
const symbols = exactConfiguredSymbols(argument('symbols', CONFIG.BINANCE_SYMBOLS.join(',')));
const requestedAsOf = argument('as-of', iso(PREVIOUS_FINAL_HOLDOUT_BOUNDARY - 1));
const parsedAsOf = Date.parse(requestedAsOf);
if (!Number.isFinite(parsedAsOf) || parsedAsOf >= PREVIOUS_FINAL_HOLDOUT_BOUNDARY) {
  throw new Error('M1.3 as-of must be before the previous M1.2 final holdout boundary');
}
const source = hasFlag('fixture') ? 'deterministic_test_fixture' : 'public_binance_futures_archive';
const fixture = hasFlag('fixture');
const concurrency = Math.max(1, Number(argument('concurrency', '8')) || 8);
const symbolConcurrency = Math.max(1, Number(argument('symbol-concurrency', '2')) || 2);
const requestTimeoutMs = Math.max(1000, Number(argument('request-timeout-ms', '30000')) || 30000);
const maxRetries = Math.max(0, Number(argument('max-retries', '2')) || 2);
const experimentSourceSha = argument('experiment-source-sha') || argument('commit-sha') || getCommitSha();
const outputPath = path.resolve(argument('out', 'reports/m1-3-final.json'));
const markdownPath = path.resolve(argument('report-out', 'docs/m1-3-cross-sectional-alpha.md'));
const admissionPath = path.resolve(argument('admission-out', 'reports/m1-3-data-admission.json'));
const auditPath = hasFlag('no-audit') ? null : path.resolve(argument('audit-out', 'reports/m1-3-audit.json'));
const experimentId = argument('experiment', `m1.3-${source}-${new Date(parsedAsOf).toISOString().slice(0, 10)}-${M13_MODEL_VERSION}`);

if (M13_PREDECLARED_CANDIDATES.length !== M13_CANDIDATE_BUDGET) {
  throw new Error(`M1.3 candidate budget mismatch: ${M13_PREDECLARED_CANDIDATES.length}/${M13_CANDIDATE_BUDGET}`);
}
if (M13_SAFETY_FLAGS.V2_PRODUCTION_ENABLED || !M13_SAFETY_FLAGS.V2_SHADOW_ONLY || M13_SAFETY_FLAGS.AUTO_TRADING || M13_SAFETY_FLAGS.M2_STARTED) {
  throw new Error('M1.3 safety flags are not research-safe');
}

const loaded = await loadWithMinimumCoverage(
  symbols,
  requestedDaysArgument,
  parsedAsOf,
  concurrency,
  symbolConcurrency,
  fixture,
);
const { window, histories } = loaded;
const requestedDays = window.expected / 24;
const coverage = histories.map(item => item.coverage);
const coverageComplete = coverage.length === symbols.length
  && coverage.every(item => item.coverage_percent === 100 && item.missing_candles === 0);
if (!coverageComplete) throw new Error('M1.3 strict per-symbol candle coverage failed');

const candleHistoryBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.candles]));
const researchCandlesBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.researchCandles]));
const generated = generateHistoricalResearchRecords({
  candlesBySymbol: candleHistoryBySymbol,
  config: CONFIG,
  asOf: parsedAsOf,
  dataSource: source,
  roundTripCostPercent: M13_ROUND_TRIP_COST_PERCENT,
  lineageOptions: {
    commitSha: experimentSourceSha,
    modelVersion: M13_MODEL_VERSION,
  },
  generationHistoryCandles: GENERATION_HISTORY_CANDLES,
  includeArtifacts: false,
});

// Check the timestamp boundary before accessing any label/outcome fields.  The
// previous final holdout is retained only as boundary/hash metadata.
const developmentV2 = generated.v2_research_records
  .filter(record => finite(record.timestamp) !== null && finite(record.timestamp) < PREVIOUS_FINAL_HOLDOUT_BOUNDARY);
const developmentV1 = generated.v1_research_records
  .filter(record => finite(record.timestamp) !== null && finite(record.timestamp) < PREVIOUS_FINAL_HOLDOUT_BOUNDARY);
const m11Samples = prepareM11Samples(
  freezeM1DevelopmentRecords(developmentV2, PREVIOUS_FINAL_HOLDOUT_BOUNDARY),
  { maximumLabelHorizonHours: 48, boundaryTimestamp: PREVIOUS_FINAL_HOLDOUT_BOUNDARY },
).filter(record => inResearchRange(record, window)).map(eventDecorate);
const m11V1Records = developmentV1.filter(record => inResearchRange(record, window)).map(eventDecorate);
const oldHoldoutRecordsPresent = generated.v2_research_records.some(record => {
  const timestamp = finite(record.timestamp);
  return timestamp !== null && timestamp >= PREVIOUS_FINAL_HOLDOUT_BOUNDARY;
});
if (oldHoldoutRecordsPresent) throw new Error('M1.3 input unexpectedly contains previous final holdout rows');
generated.normalizedBySymbol = null;
generated.rankedV2 = null;
generated.v2Records = null;
generated.v1Records = null;

const snapshotStart = window.startOpen - M13_BETA_WINDOW_HOURS * HOUR;
const snapshotResult = buildCrossSectionSnapshots({
  candlesBySymbol: researchCandlesBySymbol,
  symbols,
  startTime: snapshotStart,
  endTime: window.requestedEnd,
  minValidSymbols: M13_MIN_VALID_SYMBOLS,
});
const featureResult = buildCrossSectionalFeatures({
  ...snapshotResult,
  windowHours: M13_BETA_WINDOW_HOURS,
  minimumObservations: 120,
});
let derivativeHistory = null;
let derivativeDatasets = null;
let dataAdmission = {
  version: M13_FEATURE_VERSION,
  source,
  admitted_families: [],
  rejected_families: [...M12_DERIVATIVE_FAMILIES],
  families: {},
  liquidation: { admitted: false, status: 'LIQUIDATION_DATA_NOT_ADMITTED' },
  orderbook: { admitted: false, status: 'NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK' },
};
if (!hasFlag('no-derivatives')) {
  const derivativeStart = window.requestedStart - M13_BETA_WINDOW_HOURS * HOUR;
  derivativeHistory = await loadPublicDerivativeHistory({
    symbols,
    startTime: derivativeStart,
    endTime: window.requestedEnd,
    concurrency,
    symbolConcurrency,
    requestTimeoutMs,
    maxRetries,
    fetchImpl: fetchPublicArchive,
    onSymbolComplete: result => console.log(JSON.stringify({
      derivatives_symbol_complete: result.symbol,
      funding_rows: result.funding.rows.length,
      premium_rows: result.premium.rows.length,
      open_interest_hour_rows: result.openInterest.rows.length,
    })),
  });
  derivativeDatasets = {
    fundingBySymbol: derivativeHistory.fundingBySymbol,
    openInterestBySymbol: derivativeHistory.openInterestBySymbol,
    premiumBySymbol: derivativeHistory.premiumBySymbol,
    candlesBySymbol: researchCandlesBySymbol,
  };
  dataAdmission = buildDataAdmissionReport({
    symbols,
    startTime: window.requestedStart,
    endTime: window.requestedEnd,
    datasets: derivativeDatasets,
    source,
    coverageThreshold: M12_MIN_COVERAGE,
  });
}

let featureRows = featureResult.features.filter(row => (
  row.timestamp >= window.startOpen
  && row.timestamp + 48 * HOUR <= window.requestedEnd
));
if (derivativeDatasets) {
  featureRows = attachPointInTimeDerivativeFeatures(featureRows, derivativeDatasets);
  attachCrossSectionalDerivativeRanks(featureRows, { families: REQUIRED_X11_DERIVATIVE_FAMILIES });
}
const frozenCanonicalBoundaryPresent = featureRows.some(row => row.timestamp === FROZEN_M13_FINAL_HOLDOUT_START);
if (!fixture && !frozenCanonicalBoundaryPresent) {
  throw new Error(`M1.3 canonical WFO final holdout boundary is missing: ${FROZEN_M13_FINAL_HOLDOUT_START}`);
}
const canonicalWfoPlan = buildCanonicalWfoPlan(featureRows, {
  finalHoldoutStartTimestamp: frozenCanonicalBoundaryPresent ? FROZEN_M13_FINAL_HOLDOUT_START : null,
  trainRatio: 0.35,
  testRatio: 0.06,
  holdoutRatio: 0.20,
  purgeHours: 48,
  embargoHours: 24,
  labelHorizonHours: 48,
  minimumWindows: 6,
  includeFinalHoldoutOutcomeInHash: false,
});
const baseCrossSectionalSamples = buildDirectionalSamples({
  featureRows,
  candlesBySymbol: researchCandlesBySymbol,
  candidateId: 'X1-relative-momentum',
  roundTripCostPercent: M13_ROUND_TRIP_COST_PERCENT,
  horizons: M13_HORIZONS_HOURS,
});

const commonWfoOptions = {
  purgeHours: 48,
  embargoHours: 24,
  labelHorizonHours: 48,
  minimumWindows: 6,
  canonicalPlan: canonicalWfoPlan,
};
const baselineM11ResultRaw = runM11Candidate(m11Samples, {
  candidateId: M12_BASELINE_CANDIDATE.candidate_id,
  candidate: M12_BASELINE_CANDIDATE,
  dataSource: source,
  wfoOptions: commonWfoOptions,
});
const baselineCandidate = M13_PREDECLARED_CANDIDATES[0];
const baselineResult = resultForM13Summary(baselineM11ResultRaw, baselineCandidate);

const lineage = {
  experiment_id: experimentId,
  base_main_sha: BASE_MAIN_SHA,
  closeout_pr: CLOSEOUT_PR,
  source_commit_sha: experimentSourceSha,
  source_sha_reachable: sourceReachable(experimentSourceSha),
  symbols,
  requested_days: requestedDaysArgument,
  accepted_days: requestedDays,
  date_range: {
    requested_start: iso(window.requestedStart),
    requested_end: iso(window.requestedEnd),
    as_of: iso(parsedAsOf),
  },
  signal_config_hash: hashConfig(CONFIG),
  model_version: M13_MODEL_VERSION,
  feature_version: M13_FEATURE_VERSION,
  experiment_source_sha: experimentSourceSha,
  generation_history_candles: GENERATION_HISTORY_CANDLES,
  cross_sectional_feature_policy: {
    same_timestamp_snapshots: true,
    minimum_valid_symbols: M13_MIN_VALID_SYMBOLS,
    beta_window_hours: M13_BETA_WINDOW_HOURS,
    beta_minimum_observations: 120,
    no_global_normalization: true,
    no_future_data: true,
  },
  data_admission_policy: {
    minimum_coverage: M12_MIN_COVERAGE,
    maximum_stale_ms: M12_MAX_STALE_MS,
    admitted_families: dataAdmission.admitted_families,
    rejected_families: dataAdmission.rejected_families,
    liquidation: dataAdmission.liquidation?.status || 'LIQUIDATION_DATA_NOT_ADMITTED',
    orderbook: dataAdmission.orderbook?.status || 'NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK',
  },
  derivative_source: derivativeHistory ? {
    source,
    requested_start: iso(window.requestedStart - M13_BETA_WINDOW_HOURS * HOUR),
    requested_end: iso(window.requestedEnd),
    file_manifest: derivativeHistory.files,
    oi_sampling: 'latest public metrics row per UTC hour; original source timestamps retained',
  } : null,
  candidate_space: M13_PREDECLARED_CANDIDATES,
  candidate_budget: `${M13_PREDECLARED_CANDIDATES.length}/${M13_CANDIDATE_BUDGET}`,
  independent_event_definition: M13_INDEPENDENT_EVENT_DEFINITION,
  snapshot_event_definition: 'exact closed 1h timestamp',
  cost_round_trip_percent: M13_ROUND_TRIP_COST_PERCENT,
  cost_sensitivity_percent: M13_COST_SENSITIVITY_PERCENT,
  wfo: canonicalWfoPlan.options,
  canonical_wfo_plan_hash: canonicalWfoPlan.canonical_plan_hash,
  previous_final_holdout: {
    boundary_timestamp: PREVIOUS_FINAL_HOLDOUT_BOUNDARY,
    boundary_hash: PREVIOUS_FINAL_HOLDOUT_HASH,
    outcomes_accessed_for_selection: false,
  },
  bootstrap: {
    repetitions: M13_BOOTSTRAP_REPETITIONS,
    seed: M13_BOOTSTRAP_SEED,
    resampling_unit: 'independent_market_event_id (fixed UTC 4h bucket)',
  },
};
const configHash = m13CandidateConfigHash({
  candidate: M13_PREDECLARED_CANDIDATES,
  wfoOptions: commonWfoOptions,
  symbols,
  dataAdmission,
  holdout: lineage.previous_final_holdout,
  lineage,
});

let m12ComparatorResult = null;
let m12ComparatorSummary = null;
if (derivativeDatasets && dataAdmission.admitted_families.includes('Funding') && dataAdmission.admitted_families.includes('Basis/Premium')) {
  const enrichedM11Samples = attachPointInTimeDerivativeFeatures(m11Samples, derivativeDatasets);
  m12ComparatorResult = runM12Candidate(enrichedM11Samples, {
    candidateId: 'C7-funding-plus-basis-premium',
    candidate: {
      candidate_id: 'C7-funding-plus-basis-premium',
      base_candidate: M12_BASELINE_CANDIDATE,
      derivative_families: ['Funding', 'Basis/Premium'],
    },
    dataSource: source,
    wfoOptions: commonWfoOptions,
  });
  m12ComparatorSummary = resultForM13Summary(m12ComparatorResult, {
    candidate_id: 'C7-funding-plus-basis-premium',
    family: 'm1.2_comparator',
    primary_horizon_hours: 8,
  });
}

const candidateSummaries = [summarizeM13Candidate(baselineResult)];
let diagnosticBestSummary = null;
let diagnosticBestResult = null;
for (const candidate of M13_PREDECLARED_CANDIDATES.slice(1)) {
  const derivativeAdmitted = dataAdmission.admitted_families.length === REQUIRED_X11_DERIVATIVE_FAMILIES.length
    && REQUIRED_X11_DERIVATIVE_FAMILIES.every(family => dataAdmission.admitted_families.includes(family));
  if (candidate.requires_derivative_admission && !derivativeAdmitted) {
    candidateSummaries.push({
      candidate_id: candidate.candidate_id,
      family: candidate.family,
      direction: 'BUY and SELL',
      primary_horizon_hours: candidate.primary_horizon_hours,
      status: 'NOT_EVALUATED_DATA_NOT_ADMITTED',
      independent_generator: true,
      metrics: null,
      all_oos_metrics: null,
      selection: null,
      stability: null,
      concentration: null,
      calibration: null,
      incremental_gate: null,
      absolute_gate: null,
      comparison: null,
      train_only: true,
      point_in_time_features: true,
      final_holdout_untouched: null,
    });
    continue;
  }
  const samples = repriceSamples(baseCrossSectionalSamples, candidate);
  console.log(JSON.stringify({ candidate_started: candidate.candidate_id, sample_count: samples.length }));
  const result = runM13Candidate(samples, {
    candidateId: candidate.candidate_id,
    candidate,
    dataSource: source,
    wfoOptions: commonWfoOptions,
  });
  const candidateHash = m13CandidateConfigHash({
    candidate,
    wfoOptions: result.walk_forward.options,
    symbols,
    dataAdmission,
    holdout: lineage.previous_final_holdout,
    lineage: { ...lineage, candidate_id: candidate.candidate_id },
  });
  result.config_hash = candidateHash;
  result.candidate = { ...result.candidate, config_hash: candidateHash };
  const summary = summarizeM13Candidate(result, {
    baselineResult,
    admittedDerivativeData: derivativeAdmitted,
  });
  candidateSummaries.push(summary);
  const diagnosticDelta = finite(summary.comparison?.point_estimate?.delta_net_expectancy_percent) ?? -Infinity;
  const previousDelta = finite(diagnosticBestSummary?.comparison?.point_estimate?.delta_net_expectancy_percent) ?? -Infinity;
  if (!diagnosticBestSummary || diagnosticDelta > previousDelta
    || (diagnosticDelta === previousDelta && candidate.candidate_id.localeCompare(diagnosticBestSummary.candidate_id) < 0)) {
    diagnosticBestSummary = summary;
    diagnosticBestResult = result;
  }
  samples.length = 0;
  if (globalThis.gc) globalThis.gc();
}

if (candidateSummaries.length !== M13_CANDIDATE_BUDGET) {
  throw new Error(`M1.3 candidate summary count mismatch: ${candidateSummaries.length}/${M13_CANDIDATE_BUDGET}`);
}

const bestSummary = diagnosticBestSummary || candidateSummaries.find(summary => summary.candidate_id === baselineCandidate.candidate_id);
const bestResult = diagnosticBestResult || baselineResult;
const v1ComparatorResult = buildV1Comparator(m11V1Records, bestResult, window);
const v1Comparison = compareM13Results(v1ComparatorResult, bestResult, {
  primaryHorizonHours: bestSummary?.primary_horizon_hours || 8,
});
const m12Comparison = m12ComparatorSummary
  ? compareM13Results(m12ComparatorSummary, bestResult, { primaryHorizonHours: bestSummary?.primary_horizon_hours || 8 })
  : null;
assertM13ComparatorParity(v1Comparison, 'V1 comparator');
for (const summary of candidateSummaries.filter(item => item.status === 'EVALUATED' && item.candidate_id !== baselineCandidate.candidate_id)) {
  assertM13ComparatorParity(summary.comparison, summary.candidate_id);
}
if (m12Comparison) assertM13ComparatorParity(m12Comparison, 'M1.2 C7 comparator');
const decision = decideM13({
  candidateSummaries: diagnosticBestSummary ? candidateSummaries : [],
  bestCandidate: bestSummary,
});
const finalHoldoutUntouched = [baselineResult, diagnosticBestResult, m12ComparatorSummary]
  .filter(Boolean)
  .every(result => result.final_holdout_untouched === true);
const actualIndependentEvents = new Set(featureRows.map(row => row.independent_market_event_id).filter(Boolean));
const finalHoldout = {
  count: bestResult.walk_forward?.final_holdout_count || 0,
  start: bestResult.walk_forward?.final_holdout_start || null,
  hash: bestResult.walk_forward?.final_holdout_hash || null,
  untouched: finalHoldoutUntouched,
  outcomes_accessed_for_selection: false,
};
const diagnostics = {
  factor_correlations: buildFactorCorrelationDiagnostics(bestResult.oos_records || [], bestSummary?.primary_horizon_hours || 8),
  monthly_and_stress: buildM13StabilityDiagnostics(bestResult.oos_records || [], { primaryHorizonHours: bestSummary?.primary_horizon_hours || 8 }),
  diagnostic_selection_basis: 'largest observed common-support delta among predeclared candidates; gates and final decision remain fixed',
};
const reportLineage = {
  ...lineage,
  final_wfo_options: bestResult.walk_forward?.options || null,
  source_candle_archives: Object.fromEntries(histories.map(item => [item.symbol, item.archive])),
};
const reportConfigHash = hashConfig({ ...reportLineage, config_hash: configHash });
const reportResult = {
  base_main_sha: BASE_MAIN_SHA,
  m1_2_closeout: {
    pr_number: CLOSEOUT_PR,
    merge_sha: BASE_MAIN_SHA,
    main_head: BASE_MAIN_SHA,
    decision: 'NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN',
  },
  branch: argument('branch', 'feat/v2-cross-sectional-alpha'),
  draft_pr_number: finite(argument('draft-pr-number', null)),
  experiment_id: experimentId,
  model_version: M13_MODEL_VERSION,
  feature_version: M13_FEATURE_VERSION,
  experiment_source_sha: experimentSourceSha,
  source_sha_reachable: sourceReachable(experimentSourceSha),
  commit_sha: experimentSourceSha,
  config_hash: reportConfigHash,
  data_source: source,
  historical_target: `${requestedDaysArgument}d target; ${requestedDays}d accepted × ${symbols.length} configured symbols`,
  accepted_days: requestedDays,
  date_range: {
    start: iso(window.requestedStart),
    end: iso(window.requestedEnd),
    as_of: iso(parsedAsOf),
  },
  symbols,
  coverage,
  coverage_complete: coverageComplete,
  minimum_valid_symbols: M13_MIN_VALID_SYMBOLS,
  valid_snapshots: featureRows.length ? new Set(featureRows.map(row => row.snapshot_event_id)).size : 0,
  rejected_snapshots: snapshotResult.rejected_snapshot_count,
  independent_market_events: actualIndependentEvents.size,
  event_definitions: {
    independent: M13_INDEPENDENT_EVENT_DEFINITION,
    snapshot: 'exact closed 1h timestamp',
  },
  data_admission: dataAdmission,
  admitted_families: dataAdmission.admitted_families,
  rejected_families: dataAdmission.rejected_families,
  x11_status: dataAdmission.admitted_families.length === REQUIRED_X11_DERIVATIVE_FAMILIES.length
    && REQUIRED_X11_DERIVATIVE_FAMILIES.every(family => dataAdmission.admitted_families.includes(family))
    ? 'EVALUATED'
    : 'NOT_EVALUATED_DATA_NOT_ADMITTED',
  derivative_data: derivativeHistory ? {
    source,
    files: derivativeHistory.files,
    requested_start: iso(window.requestedStart - M13_BETA_WINDOW_HOURS * HOUR),
    requested_end: iso(window.requestedEnd),
    oi_sampling: 'latest public metrics row per UTC hour; original source timestamps retained',
  } : null,
  candidate_search_budget: `${M13_PREDECLARED_CANDIDATES.length}/${M13_CANDIDATE_BUDGET} predeclared candidates`,
  frozen_candle_baseline: baselineCandidate,
  candidates: candidateSummaries.map(compactCandidateSummary),
  best_candidate: compactCandidateSummary(bestSummary),
  best_candidate_id: bestSummary?.candidate_id || null,
  baseline_summary: compactCandidateSummary(candidateSummaries[0]),
  comparators: {
    V1_production: {
      summary: v1ComparatorResult.metrics,
      comparison: compactComparison(v1Comparison),
    },
    M1_1_frozen_candle_baseline: {
      summary: baselineResult.metrics,
      comparison: compactComparison(bestSummary?.comparison),
    },
    M1_2_C7_funding_plus_basis_premium: m12ComparatorSummary ? {
      summary: m12ComparatorSummary.metrics,
      comparison: compactComparison(m12Comparison),
    } : {
      status: 'NOT_EVALUATED_DATA_NOT_ADMITTED',
      summary: null,
      comparison: null,
    },
  },
  wfo: compactWfo(bestResult),
  cost_assumptions: {
    round_trip_percent: M13_ROUND_TRIP_COST_PERCENT,
    diagnostics_percent: M13_COST_SENSITIVITY_PERCENT,
    signal_level_gross_and_net: true,
    sensitivity_not_used_for_selection: true,
  },
  cost_sensitivity: costSensitivity(bestResult),
  diagnostics,
  previous_final_holdout: {
    boundary_timestamp: PREVIOUS_FINAL_HOLDOUT_BOUNDARY,
    boundary_hash: PREVIOUS_FINAL_HOLDOUT_HASH,
    outcomes_accessed_for_selection: false,
  },
  previous_final_holdout_outcomes_accessed: false,
  final_holdout: finalHoldout,
  final_holdout_untouched: finalHoldoutUntouched,
  FINAL_HOLDOUT_UNTOUCHED: finalHoldoutUntouched,
  flags: M13_SAFETY_FLAGS,
  COMMON_SUPPORT_COMPARISON: true,
  promotion_thresholds: M13_PROMOTION_THRESHOLDS,
  decision,
  known_limitations: [
    'This run uses closed 1h public Binance Futures candles and the configured 18-symbol universe; every symbol must meet strict 100% candle coverage.',
    'Cross-sectional snapshots require at least 12 valid symbols at the exact same timestamp; rejected breadth snapshots are not forward-filled.',
    'Rolling beta is a past-only 168h OLS estimate with a minimum of 120 observations; no global normalization or outcome-derived feature scaling is used.',
    'M1.2 C7 is a fixed comparator only; previous final holdout outcomes and previous optimization results were not used to select M1.3 policies.',
    'Liquidations and historical order-book snapshots were not admitted; optional X11 is evaluated only when all required PIT derivative families pass admission.',
    'Cost sensitivity, factor correlations, monthly slices and dispersion stress slices are diagnostic only and cannot change the decision.',
  ],
  lineage_manifest: reportLineage,
};

if (auditPath) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify({
    experiment_id: experimentId,
    model_version: M13_MODEL_VERSION,
    note: 'Ignored detailed M1.3 row-level audit; tracked report contains compact candidate summaries.',
    candidate_summaries: candidateSummaries,
  }, null, 2));
}
fs.mkdirSync(path.dirname(admissionPath), { recursive: true });
fs.writeFileSync(admissionPath, JSON.stringify({
  experiment_id: experimentId,
  model_version: M13_MODEL_VERSION,
  feature_version: M13_FEATURE_VERSION,
  config_hash: reportConfigHash,
  ...dataAdmission,
}, null, 2));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(reportResult, null, 2));
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, buildM13Markdown(reportResult));

console.log(JSON.stringify({
  experiment_id: experimentId,
  model_version: M13_MODEL_VERSION,
  feature_version: M13_FEATURE_VERSION,
  experiment_source_sha: experimentSourceSha,
  source_sha_reachable: sourceReachable(experimentSourceSha),
  accepted_days: requestedDays,
  symbols: symbols.length,
  coverage_complete: coverageComplete,
  valid_snapshots: reportResult.valid_snapshots,
  independent_market_events: actualIndependentEvents.size,
  candidates_predeclared: M13_PREDECLARED_CANDIDATES.length,
  candidates_evaluated: candidateSummaries.filter(summary => summary.status === 'EVALUATED').length,
  best_candidate_id: bestSummary?.candidate_id || null,
  final_holdout_untouched: finalHoldoutUntouched,
  decision,
  output: outputPath,
  markdown: markdownPath,
  admission: admissionPath,
  audit: auditPath,
}, null, 2));

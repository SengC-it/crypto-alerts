// Run the bounded M1.2 information-gain experiment. This is public-data-only
// research and never touches production, private exchange state, or orders.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { getCommitSha, hashConfig } from '../src/lineage.js';
import { loadBinanceVisionCandlesLongRange } from '../src/backtest/binanceArchive.js';
import { loadBacktestHistory, requestedWindow } from '../src/backtest/history.js';
import { generateHistoricalResearchRecords } from '../src/v2/experiment.js';
import { buildM12Markdown } from '../src/v2/m12Report.js';
import {
  M1_FROZEN_HOLDOUT,
  buildAblationMatrix,
  diagnoseSideways,
  freezeM1DevelopmentRecords,
  prepareM11Samples,
  primaryGross,
} from '../src/v2/edgeDiscovery.js';
import {
  M12_BASELINE_CANDIDATE,
  M12_BOOTSTRAP_REPETITIONS,
  M12_BOOTSTRAP_SEED,
  M12_CANDIDATE_BUDGET,
  M12_MODEL_VERSION,
  M12_PREDECLARED_CANDIDATES,
  M12_SAFETY_FLAGS,
  buildM12FeatureFamilyAblation,
  decideM12,
  m12CandidateConfigHash,
  runM12Candidate,
  summarizeM12Candidate,
} from '../src/v2/informationGain.js';
import {
  M12_DERIVATIVE_FAMILIES,
  M12_FEATURE_VERSION,
  M12_MAX_STALE_MS,
  M12_MIN_COVERAGE,
  attachPointInTimeDerivativeFeatures,
  buildDataAdmissionReport,
} from '../src/v2/microstructureFeatures.js';
import { loadPublicDerivativeHistory } from '../src/v2/derivativesData.js';

const HOUR = 60 * 60 * 1000;
const DEFAULT_DAYS = 180;
const ROUND_TRIP_COST_PERCENT = 0.14;
const BASE_MAIN_SHA = '4842be0c7b1e1748f933ab4b78f62ecd0fc7f776';
const M1_1_CLOSEOUT_PR = 3;
const GENERATION_HISTORY_CANDLES = 256;

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function finite(value) {
  return value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
}

function iso(value) {
  const timestamp = finite(value);
  if (timestamp === null) return null;
  const result = new Date(timestamp);
  return Number.isNaN(result.getTime()) ? null : result.toISOString();
}

function round(value, digits = 6) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function profitFactor(values) {
  const wins = values.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(values.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  return losses ? wins / losses : wins > 0 ? 999 : 0;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function exactConfiguredSymbols(value) {
  const symbols = (value || CONFIG.BINANCE_SYMBOLS.join(','))
    .split(',')
    .map(symbol => symbol.toUpperCase().trim())
    .filter(Boolean);
  const configured = [...CONFIG.BINANCE_SYMBOLS].map(symbol => symbol.toUpperCase()).sort();
  if (symbols.length !== configured.length
    || [...symbols].sort().some((symbol, index) => symbol !== configured[index])) {
    throw new Error('M1.2 requires the configured 18-symbol universe without substitutions');
  }
  return symbols;
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

async function loadResearchHistory(symbols, days, asOf, concurrency, symbolConcurrency) {
  const window = requestedWindow(days, { asOf, timeframe: '1h' });
  const archiveStart = window.startOpen - getIndicatorLookback(CONFIG) * HOUR;
  const histories = [];
  const batchSize = Math.max(1, symbolConcurrency);
  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async symbol => {
      const archive = await loadBinanceVisionCandlesLongRange({
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
        // loadBacktestHistory normalizes object-shaped candles. Keep the
        // archive-shaped copy for the public taker buy/sell fields.
        derivativeCandles: archive.candles,
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

function compactComparison(comparison) {
  if (!comparison) return null;
  return {
    common_support_clusters: comparison.common_support_clusters,
    underlying_oos_events: comparison.underlying_oos_events,
    pit_valid_common_events: comparison.pit_valid_common_events,
    baseline_action_events: comparison.baseline_action_events,
    augmented_action_events: comparison.augmented_action_events,
    paired_common_events: comparison.paired_common_events,
    baseline_selected_clusters: comparison.baseline_selected_clusters,
    augmented_selected_clusters: comparison.augmented_selected_clusters,
    paired_cluster_count: comparison.paired_cluster_ids?.length || 0,
    paired_cluster_ids_hash: hashConfig(comparison.paired_cluster_ids || []),
    paired_event_outcomes_hash: hashConfig(comparison.paired_event_outcomes || []),
    common_support_comparison: comparison.common_support_comparison,
    point_estimate: comparison.point_estimate,
    bootstrap: comparison.bootstrap,
  };
}

function compactCandidateSummary(summary) {
  return {
    ...summary,
    comparison: compactComparison(summary.comparison),
  };
}

function fitHash(candidate, admission, wfoOptions, lineage) {
  return m12CandidateConfigHash({
    candidate,
    featureVersion: M12_FEATURE_VERSION,
    dataAdmission: admission,
    wfoOptions,
    roundTripCostPercent: ROUND_TRIP_COST_PERCENT,
    generationHistoryCandles: GENERATION_HISTORY_CANDLES,
    holdout: M1_FROZEN_HOLDOUT,
    lineage,
  });
}

function costMetrics(result, cost) {
  const gross = (result?.selected_records || []).map(primaryGross).filter(value => value !== null);
  const net = gross.map(value => value - cost);
  return {
    selected_signals: net.length,
    gross_expectancy_percent: round(average(gross)),
    net_expectancy_percent: round(average(net)),
    gross_profit_factor: gross.length ? round(profitFactor(gross), 4) : null,
    net_profit_factor: net.length ? round(profitFactor(net), 4) : null,
  };
}

function costSensitivity(results) {
  return [0.10, ROUND_TRIP_COST_PERCENT, 0.20].map(cost => ({
    round_trip_cost_percent: cost,
    candidates: Object.fromEntries(results
      .filter(result => result?.status !== 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY')
      .map(result => [result.candidate_id, costMetrics(result, cost)])),
    selection_use: 'diagnostic_only; not used for candidate selection',
  }));
}

function compactWfo(result) {
  return {
    options: result.walk_forward?.options,
    window_count: result.walk_forward?.window_count || 0,
    windows: (result.walk_forward?.windows || []).map(window => ({
      index: window.index,
      train_start: window.train_start,
      train_end: window.train_end,
      test_start: window.test_start,
      test_end: window.test_end,
      purge_hours: window.purge_hours,
      embargo_hours: window.embargo_hours,
      purged_count: window.purged_count,
      embargoed_count: window.embargoed_count,
    })),
    final_holdout_count: result.walk_forward?.final_holdout_count || 0,
    final_holdout_start: result.walk_forward?.final_holdout_start || null,
    final_holdout_hash: result.walk_forward?.final_holdout_hash || null,
    final_holdout_untouched: result.final_holdout_untouched === true,
  };
}

function compactTrainPolicySummary(result) {
  return (result?.model_summaries || []).map(item => ({
    window_index: item.window_index,
    test_start: item.test_start,
    test_end: item.test_end,
    model_summary: item.model_summary,
  }));
}

const requestedDays = Number(argument('days', String(DEFAULT_DAYS)));
if (!Number.isFinite(requestedDays) || requestedDays < DEFAULT_DAYS) {
  throw new Error(`M1.2 requires at least ${DEFAULT_DAYS} historical days; received ${requestedDays}`);
}

const symbols = exactConfiguredSymbols(argument('symbols', CONFIG.BINANCE_SYMBOLS.join(',')));
const frozenBoundary = M1_FROZEN_HOLDOUT.boundary_timestamp;
const requestedAsOf = argument('as-of', iso(frozenBoundary - 1));
const parsedAsOf = Date.parse(requestedAsOf);
if (!Number.isFinite(parsedAsOf) || parsedAsOf >= frozenBoundary) {
  throw new Error('M1.2 as-of must be before the frozen M1 final holdout boundary');
}

const source = 'public_binance_futures_archive';
const concurrency = Math.max(1, Number(argument('concurrency', '8')) || 8);
const symbolConcurrency = Math.max(1, Number(argument('symbol-concurrency', '2')) || 2);
const requestTimeoutMs = Math.max(1000, Number(argument('request-timeout-ms', '30000')) || 30000);
const maxRetries = Math.max(0, Number(argument('max-retries', '2')) || 2);
const commitSha = argument('experiment-source-sha') || argument('commit-sha') || getCommitSha();
const outputPath = path.resolve(argument('out', 'reports/m1-2-final-0.1.1.json'));
const markdownPath = path.resolve(argument('report-out', 'docs/m1-2-independent-information-gain-0.1.1.md'));
const admissionPath = path.resolve(argument('admission-out', 'reports/m1-2-data-admission-0.1.1.json'));
const auditPath = hasFlag('no-audit') ? null : path.resolve(argument('audit-out', 'reports/m1-2-audit.json'));
const experimentId = argument('experiment', `m1.2-${source}-${new Date(parsedAsOf).toISOString().slice(0, 10)}-${M12_MODEL_VERSION}`);

const { window, histories } = await loadResearchHistory(
  symbols,
  requestedDays,
  parsedAsOf,
  concurrency,
  symbolConcurrency,
);
const candlesBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.candles]));
const derivativeCandlesBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.derivativeCandles]));

const derivativeStart = window.requestedStart - 48 * HOUR;
const derivativeHistory = await loadPublicDerivativeHistory({
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
const derivativeDatasets = {
  fundingBySymbol: derivativeHistory.fundingBySymbol,
  openInterestBySymbol: derivativeHistory.openInterestBySymbol,
  premiumBySymbol: derivativeHistory.premiumBySymbol,
  candlesBySymbol: derivativeCandlesBySymbol,
};
const admission = buildDataAdmissionReport({
  symbols,
  startTime: window.requestedStart,
  endTime: window.requestedEnd,
  datasets: derivativeDatasets,
  source,
  coverageThreshold: M12_MIN_COVERAGE,
});

const generated = generateHistoricalResearchRecords({
  candlesBySymbol,
  config: CONFIG,
  asOf: parsedAsOf,
  dataSource: source,
  roundTripCostPercent: ROUND_TRIP_COST_PERCENT,
  lineageOptions: {
    commitSha,
    modelVersion: M12_MODEL_VERSION,
  },
  generationHistoryCandles: GENERATION_HISTORY_CANDLES,
  includeArtifacts: false,
});
const v2ResearchRecords = generated.v2_research_records;
const frozenRecords = freezeM1DevelopmentRecords(v2ResearchRecords, frozenBoundary);
const samples = prepareM11Samples(frozenRecords, {
  maximumLabelHorizonHours: 48,
  boundaryTimestamp: frozenBoundary,
});
const oldHoldoutRecordsPresent = v2ResearchRecords.some(record => {
  const timestamp = finite(record.timestamp);
  return timestamp !== null && timestamp >= frozenBoundary;
});
if (oldHoldoutRecordsPresent) {
  throw new Error('M1.2 input unexpectedly contains rows at or after the frozen M1 holdout boundary');
}
const enrichedSamples = attachPointInTimeDerivativeFeatures(samples, derivativeDatasets);

const wfoOptions = {
  purgeHours: 48,
  embargoHours: 24,
  labelHorizonHours: 48,
  minimumWindows: 6,
};
if (M12_PREDECLARED_CANDIDATES.length > M12_CANDIDATE_BUDGET) {
  throw new Error(`M1.2 candidate budget exceeded: ${M12_PREDECLARED_CANDIDATES.length}/${M12_CANDIDATE_BUDGET}`);
}

const lineage = {
  experiment_id: experimentId,
  base_main_sha: BASE_MAIN_SHA,
  m1_1_closeout_pr: M1_1_CLOSEOUT_PR,
  source_commit_sha: commitSha,
  symbols,
  requested_days: requestedDays,
  date_range: {
    requested_start: iso(window.requestedStart),
    requested_end: iso(window.requestedEnd),
    as_of: iso(parsedAsOf),
  },
  signal_config_hash: hashConfig(CONFIG),
  model_version: M12_MODEL_VERSION,
  feature_version: M12_FEATURE_VERSION,
  experiment_source_sha: commitSha,
  generation_history_candles: GENERATION_HISTORY_CANDLES,
  derivative_source: {
    source,
    requested_start: iso(derivativeStart),
    requested_end: iso(window.requestedEnd),
    file_manifest: derivativeHistory.files,
    oi_sampling: 'latest public metrics row per UTC hour; original source timestamps retained',
  },
  data_admission_policy: {
    minimum_coverage: M12_MIN_COVERAGE,
    maximum_stale_ms: M12_MAX_STALE_MS,
    admitted_families: admission.admitted_families,
    rejected_families: admission.rejected_families,
    liquidation: admission.liquidation.status,
    orderbook: admission.orderbook.status,
  },
  candidate_space: M12_PREDECLARED_CANDIDATES,
  candidate_budget: `${M12_PREDECLARED_CANDIDATES.length}/${M12_CANDIDATE_BUDGET}`,
  frozen_candle_baseline: M12_BASELINE_CANDIDATE,
  cost_round_trip_percent: ROUND_TRIP_COST_PERCENT,
  wfo: wfoOptions,
  holdout: M1_FROZEN_HOLDOUT,
  bootstrap: {
    repetitions: M12_BOOTSTRAP_REPETITIONS,
    seed: M12_BOOTSTRAP_SEED,
    resampling_unit: 'independent market-event cluster',
  },
};
const configHash = hashConfig(lineage);

const evaluatedResults = [];
for (const candidate of M12_PREDECLARED_CANDIDATES) {
  const rejectedFamilies = candidate.derivative_families
    .filter(family => !admission.admitted_families.includes(family));
  if (rejectedFamilies.length) {
    const candidateHash = fitHash(candidate, admission, wfoOptions, lineage);
    evaluatedResults.push({
      candidate_id: candidate.candidate_id,
      candidate: { ...candidate, config_hash: candidateHash },
      config_hash: candidateHash,
      status: 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY',
      rejected_families: rejectedFamilies,
    });
    continue;
  }
  const result = runM12Candidate(enrichedSamples, {
    candidateId: candidate.candidate_id,
    candidate,
    dataSource: source,
    wfoOptions,
  });
  const candidateHash = fitHash(candidate, admission, result.walk_forward.options, lineage);
  result.config_hash = candidateHash;
  result.candidate = { ...result.candidate, config_hash: candidateHash };
  evaluatedResults.push(result);
}

const primaryResult = evaluatedResults.find(result => result.candidate_id === 'C0-candle-only-frozen-m1.1-baseline');
if (!primaryResult || primaryResult.status === 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY') {
  throw new Error('M1.2 candle-only frozen baseline did not evaluate');
}
const candidateSummaries = evaluatedResults.map(result => summarizeM12Candidate(result, {
  baselineResult: primaryResult,
  admittedFamilies: admission.admitted_families,
}));
const baselineSummary = candidateSummaries.find(summary => summary.candidate_id === primaryResult.candidate_id);
const evaluatedAugmentedSummaries = candidateSummaries.filter(summary => (
  summary.status === 'EVALUATED' && summary.derivative_families?.length
));
const diagnosticBestSummary = [...evaluatedAugmentedSummaries].sort((left, right) => (
  (right.information_gain?.observed?.delta_net_expectancy ?? -Infinity)
  - (left.information_gain?.observed?.delta_net_expectancy ?? -Infinity)
  || left.candidate_id.localeCompare(right.candidate_id)
))[0] || null;
const diagnosticBestResult = diagnosticBestSummary
  ? evaluatedResults.find(result => result.candidate_id === diagnosticBestSummary.candidate_id)
  : primaryResult;
const decision = decideM12({
  baselineSummary,
  candidateSummaries,
});

const coverage = histories.map(item => item.coverage);
const coverageComplete = coverage.length === symbols.length
  && coverage.every(item => item.coverage_percent === 100 && item.missing_candles === 0);
const finalHoldoutUntouched = evaluatedResults
  .filter(result => result.status !== 'DATA_SOURCE_REJECTED_INCOMPLETE_HISTORY')
  .every(result => result.final_holdout_untouched === true);
const ablation = buildAblationMatrix(
  diagnosticBestResult.oos_records,
  [diagnosticBestResult],
);
const sidewaysDiagnosis = diagnoseSideways({
  oosRecords: diagnosticBestResult.oos_records,
  generationDiagnostics: generated.generation_diagnostics,
});
const wfo = compactWfo(primaryResult);
const reportLineage = {
  ...lineage,
  final_wfo_options: wfo.options,
  source_candle_archives: Object.fromEntries(histories.map(item => [item.symbol, item.archive])),
};
const reportConfigHash = hashConfig(reportLineage);

const reportResult = {
  base_main_sha: BASE_MAIN_SHA,
  m1_1_closeout: {
    pr_number: M1_1_CLOSEOUT_PR,
    merge_sha: BASE_MAIN_SHA,
    main_head: BASE_MAIN_SHA,
    decision: 'NO_ROBUST_EDGE_FOUND',
  },
  experiment_id: experimentId,
  model_version: M12_MODEL_VERSION,
  feature_version: M12_FEATURE_VERSION,
  experiment_source_sha: commitSha,
  commit_sha: commitSha,
  config_hash: reportConfigHash,
  data_source: source,
  historical_target: `${requestedDays}d × ${symbols.length} configured symbols`,
  date_range: {
    start: iso(window.requestedStart),
    end: iso(window.requestedEnd),
    as_of: iso(parsedAsOf),
  },
  symbols,
  coverage,
  coverage_complete: coverageComplete,
  derivative_data: {
    source,
    requested_start: iso(derivativeStart),
    requested_end: iso(window.requestedEnd),
    files: derivativeHistory.files,
    oi_sampling: 'latest public metrics row per UTC hour; original source timestamps retained',
    source_file_lineage_hash: hashConfig(derivativeHistory.files),
  },
  data_admission: admission,
  admitted_families: admission.admitted_families,
  rejected_families: admission.rejected_families,
  COMMON_SUPPORT_COMPARISON: true,
  frozen_candle_baseline: M12_BASELINE_CANDIDATE,
  candidate_search_budget: `${M12_PREDECLARED_CANDIDATES.length}/${M12_CANDIDATE_BUDGET} predeclared candidates`,
  candidates: candidateSummaries.map(compactCandidateSummary),
  primary_candidate_id: primaryResult.candidate_id,
  baseline_summary: compactCandidateSummary(baselineSummary),
  baseline_metrics: primaryResult.metrics,
  diagnostic_max_delta_candidate_id: diagnosticBestSummary?.candidate_id || null,
  diagnostic_max_delta_candidate: diagnosticBestSummary
    ? compactCandidateSummary(diagnosticBestSummary)
    : null,
  feature_family_ablation: buildM12FeatureFamilyAblation(candidateSummaries),
  ablation,
  sideways_diagnosis: sidewaysDiagnosis,
  cost_assumptions: {
    round_trip_percent: ROUND_TRIP_COST_PERCENT,
    gross_and_net_signal_level: true,
    sensitivity_not_used_for_selection: true,
  },
  cost_sensitivity: costSensitivity(evaluatedResults),
  wfo,
  train_only_policy_lineage: compactTrainPolicySummary(diagnosticBestResult),
  frozen_m1_holdout: M1_FROZEN_HOLDOUT,
  final_holdout_outcomes_accessed: false,
  final_holdout_untouched: finalHoldoutUntouched,
  FINAL_HOLDOUT_UNTOUCHED: finalHoldoutUntouched,
  final_holdout: {
    count: diagnosticBestResult.walk_forward.final_holdout_count,
    start: diagnosticBestResult.walk_forward.final_holdout_start,
    hash: diagnosticBestResult.walk_forward.final_holdout_hash,
    untouched: diagnosticBestResult.final_holdout_untouched,
    outcomes_accessed_for_selection: false,
  },
  flags: M12_SAFETY_FLAGS,
  data_admission_artifact: admissionPath,
  decision,
  known_limitations: [
    'This bounded run targets 180d and the configured 18-symbol universe; no symbols were blacklisted by result.',
    'Only public Binance Vision archives were admitted. Liquidations were not admitted and no historical order-book proxy was used.',
    'Open-interest metrics were reduced to the latest source row per UTC hour for memory-bounded, conservative PIT lookup.',
    'All candidate normalization, train scalers, signs, thresholds and combination rules are fit inside each WFO training window.',
    'The old M1 final holdout was filtered before labels were read; the new WFO final holdout was not used for selection.',
    'Cost sensitivity at 0.10%, 0.14% and 0.20% is diagnostic only and cannot change the decision.',
    'Information-gain comparisons resample independent market-event clusters with deterministic bootstrap settings.',
  ],
  lineage_manifest: reportLineage,
};

if (auditPath) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify({
    experiment_id: experimentId,
    model_version: M12_MODEL_VERSION,
    note: 'Ignored detailed M1.2 OOS audit; compact report is the tracked artifact.',
    primary_oos_records: primaryResult.oos_records,
    diagnostic_best_oos_records: diagnosticBestResult.oos_records,
  }, null, 2));
}
fs.mkdirSync(path.dirname(admissionPath), { recursive: true });
fs.writeFileSync(admissionPath, JSON.stringify({
  experiment_id: experimentId,
  model_version: M12_MODEL_VERSION,
  feature_version: M12_FEATURE_VERSION,
  config_hash: reportConfigHash,
  ...admission,
}, null, 2));
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(reportResult, null, 2));
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, buildM12Markdown(reportResult));

console.log(JSON.stringify({
  experiment_id: experimentId,
  model_version: M12_MODEL_VERSION,
  feature_version: M12_FEATURE_VERSION,
  commit_sha: commitSha,
  config_hash: reportConfigHash,
  data_source: source,
  target_days: requestedDays,
  symbols: symbols.length,
  coverage_complete: coverageComplete,
  admitted_families: admission.admitted_families,
  rejected_families: admission.rejected_families,
  samples: enrichedSamples.length,
  candidates_predeclared: M12_PREDECLARED_CANDIDATES.length,
  candidates_evaluated: candidateSummaries.filter(summary => summary.status === 'EVALUATED').length,
  primary_candidate_id: primaryResult.candidate_id,
  diagnostic_max_delta_candidate_id: diagnosticBestSummary?.candidate_id || null,
  common_support_comparison: true,
  bootstrap_repetitions: M12_BOOTSTRAP_REPETITIONS,
  final_holdout_untouched: finalHoldoutUntouched,
  decision,
  output: outputPath,
  markdown: markdownPath,
  admission: admissionPath,
  audit: auditPath,
}, null, 2));

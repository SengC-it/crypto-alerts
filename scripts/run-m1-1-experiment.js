// Run the bounded M1.1 research program. It is candle-only, public-data,
// shadow research and never writes production or private exchange state.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { getCommitSha, hashConfig } from '../src/lineage.js';
import { loadBinanceVisionCandlesLongRange } from '../src/backtest/binanceArchive.js';
import { loadBacktestHistory, requestedWindow } from '../src/backtest/history.js';
import { generateHistoricalResearchRecords } from '../src/v2/experiment.js';
import { buildM11Markdown } from '../src/v2/m11Report.js';
import {
  M1_BASELINE,
  M1_FROZEN_HOLDOUT,
  M11_CANDIDATE_BUDGET,
  M11_MODEL_VERSION,
  buildAblationMatrix,
  candidateSummary,
  compareM11V1,
  diagnoseSideways,
  freezeM1DevelopmentRecords,
  prepareM11Samples,
  promotionDiagnostics,
  runM11Candidate,
  sampleTimestamp,
} from '../src/v2/edgeDiscovery.js';

const HOUR = 60 * 60 * 1000;
const DEFAULT_DAYS = 180;

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function makeFixture(symbol, window, phase = 0) {
  const count = window.expected + getIndicatorLookback(CONFIG) + 60;
  const start = window.startOpen - getIndicatorLookback(CONFIG) * HOUR;
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.floor(index / 150) % 3;
    const slope = cycle === 0 ? 0.0012 : cycle === 1 ? -0.001 : 0.0001;
    const base = 100 * Math.exp(slope * index / 4) + Math.sin((index + phase) / 9) * 1.5;
    const close = Math.max(1, base + Math.sin(index / 3 + phase) * (cycle === 2 ? 0.8 : 0.25));
    const previous = index
      ? 100 * Math.exp(slope * (index - 1) / 4) + Math.sin((index - 1 + phase) / 9) * 1.5
      : close;
    const open = Math.max(1, previous);
    const spread = cycle === 2 ? 2.2 : 0.7;
    return {
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 1000 + (index % 17) * 40 + (cycle === 0 ? 100 : 0),
      quote_volume: close * (1000 + (index % 17) * 40),
      open_time: start + index * HOUR,
      close_time: start + (index + 1) * HOUR - 1,
      timeframe: '1h',
      is_closed: true,
      symbol,
    };
  });
}

const CANDIDATE_CONFIGS = Object.freeze([
  {
    candidate_id: 'A-equal-weight-train-event-top1',
    score_method: 'equal_weight',
    event_policy: 'train_select',
    cluster_top_n: 1,
    horizon_policy: 'train_selected_per_setup',
  },
  {
    candidate_id: 'B-empirical-global-train-event-top1',
    score_method: 'empirical_global',
    event_policy: 'train_select',
    cluster_top_n: 1,
    horizon_policy: 'train_selected_per_setup',
  },
  {
    candidate_id: 'C-empirical-setup-train-event-top1',
    score_method: 'empirical_setup',
    event_policy: 'train_select',
    cluster_top_n: 1,
    horizon_policy: 'train_selected_per_setup',
  },
  ...['Trend', 'Momentum', 'Participation', 'Market Structure', 'Higher Timeframe'].map(group => ({
    candidate_id: `A-equal-weight-minus-${group.toLowerCase().replace(/[^a-z]+/g, '-')}`,
    score_method: 'equal_weight',
    omit_group: group,
    event_policy: 'train_select',
    cluster_top_n: 1,
    horizon_policy: 'train_selected_per_setup',
  })),
  {
    candidate_id: 'B-empirical-global-train-event-topN',
    score_method: 'empirical_global',
    event_policy: 'train_select',
    cluster_top_n: 'train_select',
    horizon_policy: 'train_selected_per_setup',
  },
  {
    candidate_id: 'A-equal-weight-fixed-1h-event-top1',
    score_method: 'equal_weight',
    event_policy: 'fixed',
    event_window_hours: 1,
    cluster_top_n: 1,
    horizon_policy: 'train_selected_per_setup',
  },
  {
    candidate_id: 'A-equal-weight-fixed-4h-event-top1',
    score_method: 'equal_weight',
    event_policy: 'fixed',
    event_window_hours: 4,
    cluster_top_n: 1,
    horizon_policy: 'train_selected_per_setup',
  },
]);

if (CANDIDATE_CONFIGS.length > M11_CANDIDATE_BUDGET) {
  throw new Error(`M1.1 candidate budget exceeded: ${CANDIDATE_CONFIGS.length}/${M11_CANDIDATE_BUDGET}`);
}

async function loadResearchHistory(symbols, days, asOf, source, concurrency) {
  const window = requestedWindow(days, { asOf, timeframe: '1h' });
  const archiveStart = window.startOpen - getIndicatorLookback(CONFIG) * HOUR;
  const histories = [];
  for (let index = 0; index < symbols.length; index += 4) {
    const batch = symbols.slice(index, index + 4);
    const results = await Promise.all(batch.map(async (symbol, batchIndex) => {
      let archive = null;
      if (source === 'public_binance_futures_archive') {
        archive = await loadBinanceVisionCandlesLongRange({
          symbol,
          timeframe: '1h',
          startTime: archiveStart,
          endTime: window.requestedEnd,
          concurrency,
        });
      }
      const history = await loadBacktestHistory(symbol, days, {
        config: CONFIG,
        asOf,
        strictCoverage: true,
        candles: archive?.candles || makeFixture(symbol, window, index + batchIndex),
      });
      return {
        symbol,
        candles: history.candles,
        coverage: { symbol, ...history.coverage },
        archive: archive
          ? {
            archive_months: archive.archive_months,
            monthly_archive_months: archive.monthly_archive_months,
            daily_fallback_dates: archive.daily_fallback_dates,
            missing_archive_dates: archive.missing_archive_dates,
          }
          : null,
      };
    }));
    histories.push(...results);
  }
  return { window, histories };
}

function compactCandidateDetail(result) {
  return {
    candidate_id: result.candidate_id,
    candidate: result.candidate,
    metrics: result.metrics,
    selection: result.selection,
    stability: result.stability,
    concentration: result.concentration,
    promotion: result.promotion,
    model_summaries: result.model_summaries,
  };
}

function selectBestCandidate(results) {
  return results.find(result => result.promotion?.recommendation === 'SHADOW_CANDIDATE') || null;
}

function iso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

const requestedDays = Number(argument('days', String(DEFAULT_DAYS)));
if (!Number.isFinite(requestedDays) || requestedDays < 180) {
  throw new Error(`M1.1 requires at least 180 historical days; received ${requestedDays}`);
}

const symbols = (argument('symbols', CONFIG.BINANCE_SYMBOLS.join(',')) || '')
  .split(',')
  .map(symbol => symbol.toUpperCase().trim())
  .filter(Boolean);
const configuredSymbols = [...CONFIG.BINANCE_SYMBOLS].map(symbol => symbol.toUpperCase()).sort();
if (symbols.length !== configuredSymbols.length
  || [...symbols].sort().some((symbol, index) => symbol !== configuredSymbols[index])) {
  throw new Error('M1.1 requires the configured 18-symbol universe without substitutions');
}

const frozenBoundary = M1_FROZEN_HOLDOUT.boundary_timestamp;
const requestedAsOf = argument('as-of', iso(frozenBoundary - 1));
const parsedAsOf = Date.parse(requestedAsOf);
if (!Number.isFinite(parsedAsOf) || parsedAsOf >= frozenBoundary) {
  throw new Error('M1.1 as-of must be before the frozen M1 final holdout boundary');
}
const source = hasFlag('fixture') ? 'deterministic_test_fixture' : 'public_binance_futures_archive';
const concurrency = Math.max(1, Number(argument('concurrency', '8')) || 8);
const commitSha = argument('commit-sha') || getCommitSha();
const outputPath = path.resolve(argument('out', 'reports/m1-1-final.json'));
const markdownPath = path.resolve(argument('report-out', 'docs/m1-1-edge-discovery.md'));
const auditPath = hasFlag('no-audit') ? null : path.resolve(argument('audit-out', 'reports/m1-1-audit.json'));
const experimentId = argument('experiment', `m1.1-${source}-${new Date(parsedAsOf).toISOString().slice(0, 10)}-${M11_MODEL_VERSION}`);

const { window, histories } = await loadResearchHistory(symbols, requestedDays, parsedAsOf, source, concurrency);
const candlesBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.candles]));
const generated = generateHistoricalResearchRecords({
  candlesBySymbol,
  config: CONFIG,
  asOf: parsedAsOf,
  dataSource: source,
  roundTripCostPercent: 0.14,
  lineageOptions: {
    commitSha,
    modelVersion: M11_MODEL_VERSION,
  },
  generationHistoryCandles: 256,
  includeArtifacts: false,
});
const v2ResearchRecords = generated.v2_research_records;
const v1ResearchRecords = generated.v1_research_records;
const generationDiagnostics = generated.generation_diagnostics;
// The compact records are now independent of the generator's large in-memory
// candidate/evaluation graph; release it before the bounded candidate sweep.
generated.normalizedBySymbol = null;
generated.rankedV2 = null;
generated.v2Records = null;
generated.v1Records = null;

// The timestamp filter runs before labels are read. The old holdout boundary
// and hash are retained as audit metadata only.
const frozenRecords = freezeM1DevelopmentRecords(v2ResearchRecords, frozenBoundary);
const samples = prepareM11Samples(frozenRecords, {
  maximumLabelHorizonHours: 48,
  boundaryTimestamp: frozenBoundary,
});
const oldHoldoutRecordsPresent = v2ResearchRecords.some(record => {
  const timestamp = sampleTimestamp(record);
  return timestamp !== null && timestamp >= frozenBoundary;
});
if (oldHoldoutRecordsPresent) throw new Error('M1.1 input unexpectedly contains rows at or after the frozen M1 holdout boundary');

const wfoOptions = {
  purgeHours: 48,
  embargoHours: 24,
  labelHorizonHours: 48,
  minimumWindows: 6,
};

// Run the predeclared equal-weight diagnostic first so the ablation matrix is
// available before the empirical candidates are evaluated.
const results = [];
for (const candidate of CANDIDATE_CONFIGS) {
  const result = runM11Candidate(samples, {
    candidateId: candidate.candidate_id,
    candidate,
    dataSource: source,
    wfoOptions,
  });
  result.promotion = promotionDiagnostics(result);
  results.push(result);
}

const primaryResult = results[0];
const bestResult = selectBestCandidate(results) || primaryResult;
const ablation = buildAblationMatrix(primaryResult.oos_records, results);
const sidewaysDiagnosis = diagnoseSideways({
  oosRecords: primaryResult.oos_records,
  generationDiagnostics,
});
const v1Comparison = compareM11V1(bestResult, v1ResearchRecords);
const m1Comparison = {
  net_profit_factor_delta: bestResult.metrics.net_profit_factor === null
    ? null
    : +(bestResult.metrics.net_profit_factor - M1_BASELINE.net_profit_factor).toFixed(6),
  net_expectancy_percent_delta: bestResult.metrics.net_expectancy_percent === null
    ? null
    : +(bestResult.metrics.net_expectancy_percent - M1_BASELINE.net_expectancy_percent).toFixed(6),
  selected_signals_delta: (bestResult.metrics.selected_oos_signals || 0) - M1_BASELINE.selected_oos_signals,
  independent_clusters_delta: (bestResult.metrics.independent_market_clusters || 0) - M1_BASELINE.independent_oos_clusters,
  calibration_change: `${bestResult.metrics.score_calibration.status} vs ${M1_BASELINE.calibration}`,
  positive_window_change: (bestResult.stability.positive_windows || 0) - M1_BASELINE.positive_windows,
};

const coverage = histories.map(item => item.coverage);
const coverageComplete = coverage.length === 18 && coverage.every(item => item.coverage_percent === 100 && item.missing_candles === 0);
const evidenceSufficient = coverageComplete
  && samples.length >= 100
  && primaryResult.walk_forward.window_count >= 6;
const decision = bestResult.promotion?.recommendation === 'SHADOW_CANDIDATE'
  ? 'SHADOW_CANDIDATE'
  : evidenceSufficient ? 'NO_ROBUST_EDGE_FOUND' : 'INSUFFICIENT_EVIDENCE';

const configHash = hashConfig({
  experiment_id: experimentId,
  model_version: M11_MODEL_VERSION,
  base_main_sha: '7566ba8c6972153d69904722542a118be6cd2b35',
  symbols,
  requested_days: requestedDays,
  as_of: parsedAsOf,
  cost_round_trip_percent: 0.14,
  candidate_budget: M11_CANDIDATE_BUDGET,
  candidate_space: CANDIDATE_CONFIGS,
  wfo: wfoOptions,
  frozen_m1_holdout: M1_FROZEN_HOLDOUT,
});

const reportResult = {
  base_main_sha: '7566ba8c6972153d69904722542a118be6cd2b35',
  experiment_id: experimentId,
  model_version: M11_MODEL_VERSION,
  commit_sha: commitSha,
  config_hash: configHash,
  data_source: source,
  historical_target: `${requestedDays}d (minimum 180d; preferred 365d)`,
  date_range: {
    start: iso(window.requestedStart),
    end: iso(window.requestedEnd),
    as_of: iso(parsedAsOf),
  },
  coverage,
  coverage_complete: coverageComplete,
  symbols,
  cost_assumptions: {
    round_trip_percent: 0.14,
    gross_and_net_signal_level: true,
  },
  candidate_search_budget: `${CANDIDATE_CONFIGS.length}/${M11_CANDIDATE_BUDGET} predeclared candidates`,
  candidates: results.map(candidateSummary),
  primary_candidate_id: primaryResult.candidate_id,
  best_candidate_id: selectBestCandidate(results)?.candidate_id || null,
  primary_candidate: compactCandidateDetail(primaryResult),
  best_candidate: compactCandidateDetail(bestResult),
  ablation,
  sideways_diagnosis: sidewaysDiagnosis,
  frozen_m1_holdout: M1_FROZEN_HOLDOUT,
  final_holdout_outcomes_accessed: false,
  final_holdout_untouched: results.every(result => result.final_holdout_untouched),
  new_final_holdout: {
    count: bestResult.walk_forward.final_holdout_count,
    start: bestResult.walk_forward.final_holdout_start,
    hash: bestResult.walk_forward.final_holdout_hash,
    untouched: bestResult.final_holdout_untouched,
    purge_hours: bestResult.walk_forward.options.purgeHours,
    embargo_hours: bestResult.walk_forward.options.embargoHours,
    window_boundaries: bestResult.walk_forward.windows.map(windowResult => ({
      index: windowResult.index,
      train_start: windowResult.train_start,
      train_end: windowResult.train_end,
      test_start: windowResult.test_start,
      test_end: windowResult.test_end,
    })),
    trained_policy_summary: bestResult.model_summaries,
  },
  primary_horizon_policy: 'train-selected per setup with 4h fallback',
  market_event_policy: 'train-selected 1h vs 4h for dynamic candidates; fixed-policy ablations retained',
  cluster_policy: 'score eligibility -> market event -> direction -> rank -> Top-N; Top-N is fixed or train-selected from {1,2}',
  public_derivatives_data_used: false,
  oos_selected_metrics: bestResult.metrics,
  oos_selection: bestResult.selection,
  stability: bestResult.stability,
  concentration: bestResult.concentration,
  calibration: bestResult.calibration,
  v1_comparison: v1Comparison,
  m1_comparison: m1Comparison,
  promotion: bestResult.promotion,
  flags: {
    V1_UNCHANGED: true,
    V2_PRODUCTION_ENABLED: false,
    V2_SHADOW_ONLY: true,
    AUTO_TRADING: false,
    M2_STARTED: false,
  },
  decision,
  known_limitations: [
    'The primary target is 180d; 365d was not requested for this bounded run.',
    'Only public candle data was admitted. Funding, open interest and spread were not used.',
    'The old M1 final holdout was frozen by boundary/hash metadata and not used for model selection.',
    'The new M1.1 final holdout remains reserved for a later validation phase.',
    'No candidate was selected from an OOS performance ranking; all predeclared candidate summaries are retained.',
  ],
};

if (auditPath) {
  fs.mkdirSync(path.dirname(auditPath), { recursive: true });
  fs.writeFileSync(auditPath, JSON.stringify({
    experiment_id: experimentId,
    model_version: M11_MODEL_VERSION,
    note: 'Ignored detailed M1.1 OOS audit; compact report is the tracked artifact.',
    primary_oos_records: primaryResult.oos_records,
  }, null, 2));
}
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(reportResult, null, 2));
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, buildM11Markdown(reportResult));

console.log(JSON.stringify({
  experiment_id: experimentId,
  model_version: M11_MODEL_VERSION,
  commit_sha: commitSha,
  config_hash: configHash,
  data_source: source,
  target_days: requestedDays,
  actual_coverage_complete: coverageComplete,
  symbols: symbols.length,
  frozen_m1_holdout: M1_FROZEN_HOLDOUT,
  samples: samples.length,
  candidates_evaluated: results.length,
  primary_candidate_id: primaryResult.candidate_id,
  best_candidate_id: reportResult.best_candidate_id,
  best_candidate: candidateSummary(bestResult),
  v1_comparison: v1Comparison,
  m1_comparison: m1Comparison,
  final_holdout_untouched: reportResult.final_holdout_untouched,
  decision,
  output: outputPath,
  markdown: markdownPath,
  audit: auditPath,
}, null, 2));

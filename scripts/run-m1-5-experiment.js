// Run the single official M1.5 causal sparsification validation.
//
// The period, symbols, candidate, policies, horizon, cost, windows, and
// bootstrap settings are intentionally fixed. This script is research-only:
// it does not deploy V2, enable trading, or start M2.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { getCommitSha, hashConfig } from '../src/lineage.js';
import { filterClosedCandles } from '../src/market/candle.js';
import { loadBinanceVisionCandlesLongRange } from '../src/backtest/binanceArchive.js';
import {
  M13_BETA_WINDOW_HOURS,
  M13_HORIZONS_HOURS,
  M13_MIN_VALID_SYMBOLS,
  buildCrossSectionSnapshots,
  buildCrossSectionalFeatures,
  buildDirectionalSamples,
} from '../src/v2/crossSectional.js';
import { buildScoreCalibration } from '../src/v2/scoring.js';
import {
  M15_BASE_MAIN_SHA,
  M15_BOOTSTRAP_REPETITIONS,
  M15_BOOTSTRAP_SEED,
  M15_COST_PERCENT,
  M15_EXPERIMENT_ID,
  M15_M14_SOURCE_SHA,
  M15_MIN_BUCKET_CLOSE_BREADTH,
  M15_MOVING_BLOCK_LENGTH,
  M15_OUTCOME_DATA_END,
  M15_POLICY_IDS,
  M15_POLICY_ORDER,
  M15_PRIMARY_HORIZON_HOURS,
  M15_RESEARCH_VERSION,
  M15_SAFETY_FLAGS,
  M15_VALIDATION_WINDOW_COUNT,
  M15_VALIDATION_SIGNAL_END,
  M15_VALIDATION_SIGNAL_START,
  buildCausalViews,
  buildCausalityGap,
  buildDiscoveryRetention,
  buildM15ConfigHash,
  buildRetrospectiveViews,
  buildValidationWindows,
  compactPolicyMetrics,
  evaluateAbsolutePromotion,
  evaluateC1Confirmation,
  evaluateD1Replication,
  evaluateM15Policy,
  resolveM15Decision,
  toPolicyReport,
} from '../src/v2/m15CausalSparsification.js';

const HOUR = 60 * 60 * 1000;
const REQUIRED_SYMBOL_COUNT = 18;
const REQUIRED_SIGNAL_START = Date.parse(M15_VALIDATION_SIGNAL_START);
const REQUIRED_SIGNAL_END = Date.parse(M15_VALIDATION_SIGNAL_END);
const OUTCOME_END = Date.parse(M15_OUTCOME_DATA_END);
const REQUIRED_CANDLE_START_OPEN = REQUIRED_SIGNAL_START - HOUR + 1;
const REQUIRED_CANDLE_END_OPEN = OUTCOME_END - HOUR + 1;
const WARMUP_HOURS = getIndicatorLookback(CONFIG) + M13_BETA_WINDOW_HOURS + 48;
const WARMUP_START_OPEN = REQUIRED_CANDLE_START_OPEN - WARMUP_HOURS * HOUR;

let requestTimeoutMs = 30000;
let maxRetries = 2;

function argument(name, fallback = null) {
  const prefix = '--' + name + '=';
  const match = process.argv.find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function iso(value) {
  const numeric = finite(value);
  return numeric === null ? null : new Date(numeric).toISOString();
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function sourceReachable(sourceSha) {
  if (!sourceSha || sourceSha === 'unknown') return false;
  try {
    execFileSync('git', ['cat-file', '-e', sourceSha + '^{commit}'], {
      cwd: process.cwd(),
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

function exactConfiguredSymbols() {
  const symbols = [...CONFIG.BINANCE_SYMBOLS].map(symbol => String(symbol).toUpperCase());
  const unique = [...new Set(symbols)].sort();
  if (symbols.length !== REQUIRED_SYMBOL_COUNT || unique.length !== REQUIRED_SYMBOL_COUNT) {
    throw new Error('M1.5 requires exactly the configured 18-symbol universe');
  }
  return symbols.sort();
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
        throw new Error('retryable_http_' + response.status);
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
  throw lastError || new Error('Public archive request failed: ' + url);
}

function canonicalClosedCandles(candles, symbol) {
  const normalized = filterClosedCandles(candles, {
    symbol,
    timeframe: '1h',
    now: OUTCOME_END + 1,
  });
  const byOpen = new Map();
  for (const candle of normalized) {
    if (finite(candle.open_time) !== null) byOpen.set(Number(candle.open_time), candle);
  }
  return [...byOpen.values()].sort((left, right) => left.open_time - right.open_time);
}

function expectedHourlyOpens(startOpen, endOpen) {
  const opens = [];
  for (let open = startOpen; open <= endOpen; open += HOUR) opens.push(open);
  return opens;
}

function buildCoverage(symbol, candles, archive) {
  const expected = expectedHourlyOpens(REQUIRED_CANDLE_START_OPEN, REQUIRED_CANDLE_END_OPEN);
  const expectedSet = new Set(expected);
  const periodCandles = candles.filter(candle => expectedSet.has(Number(candle.open_time)));
  const actual = new Set(periodCandles.map(candle => Number(candle.open_time)));
  const missing = expected.filter(open => !actual.has(open));
  const first = periodCandles[0] || null;
  const last = periodCandles.at(-1) || null;
  return {
    symbol,
    timeframe: '1h',
    requested_start_open: iso(REQUIRED_CANDLE_START_OPEN),
    requested_end_open: iso(REQUIRED_CANDLE_END_OPEN),
    expected_candles: expected.length,
    loaded_candles: actual.size,
    missing_candles: missing.length,
    coverage_percent: round(expected.length ? actual.size / expected.length * 100 : 0, 6),
    first_loaded_open: iso(first?.open_time),
    last_loaded_open: iso(last?.open_time),
    first_loaded_close: iso(first?.close_time),
    last_loaded_close: iso(last?.close_time),
    source_timestamps: {
      archive_requested_start: iso(archive.requested_start),
      archive_requested_end: iso(archive.requested_end),
      monthly_archive_months: archive.monthly_archive_months || [],
      daily_fallback_dates: archive.daily_fallback_dates || [],
      missing_archive_dates: archive.missing_archive_dates || [],
    },
    missing_sample: missing.slice(0, 5).map(iso),
  };
}

async function loadResearchData(symbols, {
  archiveConcurrency,
  symbolConcurrency,
}) {
  const histories = [];
  const batchSize = Math.max(1, symbolConcurrency);
  for (let index = 0; index < symbols.length; index += batchSize) {
    const batch = symbols.slice(index, index + batchSize);
    const results = await Promise.all(batch.map(async symbol => {
      const archive = await loadBinanceVisionCandlesLongRange({
        symbol,
        timeframe: '1h',
        startTime: WARMUP_START_OPEN,
        endTime: OUTCOME_END,
        concurrency: archiveConcurrency,
        fetchImpl: fetchPublicArchive,
      });
      const candles = canonicalClosedCandles(archive.candles, symbol);
      const coverage = buildCoverage(symbol, candles, archive);
      if (coverage.missing_candles > 0 || coverage.coverage_percent < 100) {
        throw new Error(
          'M1.5 strict coverage failed for ' + symbol
          + ': ' + coverage.loaded_candles + '/' + coverage.expected_candles
          + '; missing=' + coverage.missing_candles,
        );
      }
      return { symbol, candles, coverage };
    }));
    histories.push(...results);
  }
  histories.sort((left, right) => left.symbol.localeCompare(right.symbol));
  return {
    candlesBySymbol: Object.fromEntries(histories.map(item => [item.symbol, item.candles])),
    coverage: histories.map(item => item.coverage),
  };
}

function recordsInValidationPeriod(samples) {
  return samples.filter(record => {
    const timestamp = finite(record.timestamp);
    return timestamp !== null
      && timestamp >= REQUIRED_SIGNAL_START
      && timestamp <= REQUIRED_SIGNAL_END
      && record.point_in_time !== false
      && record.future_data_used !== true;
  });
}

function outcomeValue(record) {
  const gross = finite(record.forward_returns?.['8h']);
  return gross === null ? null : gross - M15_COST_PERCENT;
}

function assertOutcomeCoverage(records) {
  const missing = records.filter(record => outcomeValue(record) === null);
  if (missing.length) {
    throw new Error('M1.5 strict 8h outcome coverage failed for ' + missing.length + ' validation records');
  }
}

function calibrationForC1(records) {
  return buildScoreCalibration(records.map(record => ({
    raw_score: record.raw_score,
    outcome: outcomeValue(record),
    gross_return_percent: finite(record.forward_returns?.['8h']),
    mfe_percent: finite(record.mfe_percent),
    mae_percent: finite(record.mae_percent),
  })), {
    binCount: 5,
  });
}

function directionReports(records, validationPlan) {
  const result = {};
  for (const direction of ['BUY', 'SELL']) {
    const policy = evaluateM15Policy(
      records.filter(record => String(record.direction).toUpperCase() === direction),
      validationPlan,
    );
    result[direction] = compactPolicyMetrics(policy);
  }
  return result;
}

function rejectionSummary(rejectedEvents) {
  const byReason = {};
  for (const event of rejectedEvents) {
    byReason[event.reason] = (byReason[event.reason] || 0) + 1;
  }
  return {
    rejected_event_count: rejectedEvents.length,
    by_reason: byReason,
  };
}

function policyContract() {
  return {
    [M15_POLICY_IDS.D1]: {
      selection: 'M1.4 buildDensityViews TOP1_PER_4H_EVENT_PER_DIRECTION',
      retrospective: true,
      deployable: false,
      causal: false,
    },
    [M15_POLICY_IDS.D2]: {
      selection: 'M1.4 buildDensityViews TOP1_PER_4H_EVENT_TOTAL',
      retrospective: true,
      deployable: false,
      causal: false,
    },
    [M15_POLICY_IDS.C1]: {
      selection: 'last fully closed 1h snapshot at each fixed UTC 4h bucket close; max one BUY and one SELL',
      retrospective: false,
      deployable: true,
      causal: true,
      primary_confirmatory: true,
    },
    [M15_POLICY_IDS.C2]: {
      selection: 'last fully closed 1h snapshot at each fixed UTC 4h bucket close; max one total signal',
      retrospective: false,
      deployable: true,
      causal: true,
      secondary_only: true,
    },
  };
}

function buildOutcomeManifest(records, symbols) {
  return {
    version: M15_RESEARCH_VERSION,
    source: 'derived after frozen point-in-time selection',
    horizon_hours: M15_PRIMARY_HORIZON_HOURS,
    cost_percent: M15_COST_PERCENT,
    symbol_counts: Object.fromEntries(symbols.map(symbol => [
      symbol,
      records.filter(record => String(record.symbol).toUpperCase() === symbol).length,
    ])),
    selected_outcome_fingerprint: hashConfig(records.map(record => ({
      event_id: record.independent_market_event_id,
      symbol: record.symbol,
      direction: record.direction,
      gross_8h: record.forward_returns?.['8h'] ?? null,
      net_8h: outcomeValue(record),
    })).sort((left, right) => (
      String(left.event_id).localeCompare(String(right.event_id))
      || String(left.symbol).localeCompare(String(right.symbol))
      || String(left.direction).localeCompare(String(right.direction))
    ))),
  };
}

function markdownReport(report) {
  const c1 = report.policies[M15_POLICY_IDS.C1];
  const decision = report.decision;
  const windows = report.validation.windows;
  const lines = [
    '# M1.5 — Causal Signal Sparsification Independent Temporal Validation',
    '',
    '- Research version: ' + report.research_version,
    '- Experiment ID: ' + report.experiment_id,
    '- Decision: ' + decision,
    '- Official performance runs: ' + report.official_performance_run_count,
    '- Production deployment: false',
    '- M2 started: false',
    '',
    '## Frozen lineage',
    '',
    '- Base main SHA: ' + report.base_main_sha,
    '- M1.4 source SHA: ' + report.m1_4_source_sha,
    '- Experiment source SHA: ' + report.experiment_source_sha,
    '- Supersedes: ' + report.supersedes_run_version + ' (' + report.supersedes_reason + ')',
    '- Prior run status: ' + report.prior_run_status,
    '- Config hash: ' + report.config_hash,
    '- Validation data manifest hash: ' + report.validation_data_manifest_hash,
    '- Outcome data manifest hash: ' + report.outcome_data_manifest_hash,
    '',
    '## Fixed validation contract',
    '',
    '- Signal range: ' + report.validation.signal_start + ' through ' + report.validation.signal_end,
    '- Outcome data end: ' + report.validation.outcome_data_end,
    '- Candidate: ' + report.candidate_id,
    '- Horizon: ' + report.primary_horizon_hours + 'h',
    '- Net round-trip cost: ' + report.round_trip_cost_percent + '%',
    '- Causal bucket-close breadth floor: ' + report.causal_bucket_close_min_valid_symbols,
    '- Contiguous windows: ' + windows.length + ' (plan hash ' + report.validation.validation_plan_hash + ')',
    '- Event-window map hash: ' + report.validation.validation_event_window_map_hash,
    '- Standard bootstrap: ' + report.bootstrap.repetitions + ' reps, seed ' + report.bootstrap.seed,
    '- Moving block bootstrap: ' + report.bootstrap.block_length_events + ' events / ' + report.bootstrap.block_length_hours + 'h',
    '',
    '## C1 result',
    '',
    '| Metric | Value |',
    '| --- | ---: |',
    '| Independent events | ' + c1.independent_events + ' |',
    '| Net expectancy | ' + c1.net_expectancy_percent + '% |',
    '| Net profit factor | ' + c1.net_pf + ' |',
    '| Net positive windows | ' + c1.net_positive_windows + '/' + c1.total_windows + ' |',
    '| Standard net CI95 | ' + JSON.stringify(c1.standard_bootstrap.net.ci95) + ' |',
    '| Standard P(mean > 0) | ' + c1.standard_bootstrap.net.p_gt_zero + ' |',
    '| Moving-block net CI95 | ' + JSON.stringify(c1.moving_block_bootstrap.net.ci95) + ' |',
    '| Moving-block P(mean > 0) | ' + c1.moving_block_bootstrap.net.p_gt_zero + ' |',
    '| Calibration | ' + (c1.calibration?.status || 'UNKNOWN') + ' |',
    '| C1 confirmation gate | ' + c1.gate.pass + ' |',
    '| Absolute promotion gate | ' + report.gates.absolute_promotion.pass + ' |',
    '',
    '## Policy gates',
    '',
    '| Policy | Pass | Deployable | Secondary only |',
    '| --- | --- | --- | --- |',
  ];
  for (const policyId of M15_POLICY_ORDER) {
    const policy = report.policies[policyId];
    lines.push('| ' + policyId + ' | ' + policy.gate.pass + ' | ' + policy.deployable + ' | ' + policy.secondary_only + ' |');
  }
  lines.push(
    '',
    '## Validation windows',
    '',
    '| Index | Events | Event start | Event end |',
    '| ---: | ---: | --- | --- |',
  );
  for (const window of windows) {
    lines.push(
      '| ' + window.index
      + ' | ' + window.event_count
      + ' | ' + window.event_id_start
      + ' | ' + window.event_id_end
      + ' |',
    );
  }
  lines.push(
    '',
    'The causality gap and discovery-retention delta are diagnostics only. No symbol, direction, regime, threshold, or horizon filter was introduced, and no production route was changed.',
    '',
  );
  return lines.join('\n');
}

function writeArtifact(filePath, value, json = false) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (json) fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
  else fs.writeFileSync(filePath, value);
}

async function main() {
  const branch = argument('branch');
  const experimentSourceSha = argument('experiment-source-sha', getCommitSha());
  const draftPrNumber = positiveInteger(argument('draft-pr-number'), null);
  if (branch !== 'feat/m1-5-causal-sparsification-validation') {
    throw new Error('M1.5 must run on feat/m1-5-causal-sparsification-validation');
  }
  if (!sourceReachable(experimentSourceSha)) {
    throw new Error('M1.5 experiment source SHA is not reachable: ' + experimentSourceSha);
  }
  if (!draftPrNumber) throw new Error('M1.5 requires the single Draft PR number');

  requestTimeoutMs = positiveInteger(argument('request-timeout-ms'), requestTimeoutMs);
  maxRetries = positiveInteger(argument('max-retries'), maxRetries);
  const archiveConcurrency = positiveInteger(argument('archive-concurrency'), 6);
  const symbolConcurrency = positiveInteger(argument('symbol-concurrency'), 2);
  const reportPath = path.resolve(argument('report-out', 'reports/m1-5-causal-sparsification-validation-0.1.1.json'));
  const manifestPath = path.resolve(argument('manifest-out', 'reports/m1-5-validation-data-manifest-0.1.1.json'));
  const docsPath = path.resolve(argument('docs-out', 'docs/m1-5-causal-sparsification-validation-0.1.1.md'));
  const symbols = exactConfiguredSymbols();

  const data = await loadResearchData(symbols, { archiveConcurrency, symbolConcurrency });
  const validationDataManifest = {
    version: M15_RESEARCH_VERSION,
    experiment_id: M15_EXPERIMENT_ID,
    data_source: 'public Binance Futures 1h closed-candle archives',
    configured_symbols: symbols,
    signal_start: M15_VALIDATION_SIGNAL_START,
    signal_end: M15_VALIDATION_SIGNAL_END,
    outcome_data_end: M15_OUTCOME_DATA_END,
    required_candle_open_start: iso(REQUIRED_CANDLE_START_OPEN),
    required_candle_open_end: iso(REQUIRED_CANDLE_END_OPEN),
    warmup_start_open: iso(WARMUP_START_OPEN),
    warmup_hours: WARMUP_HOURS,
    timeframe: '1h',
    exact_coverage_required: true,
    per_symbol: data.coverage,
  };
  const validationDataManifestHash = hashConfig(validationDataManifest);

  const snapshotResult = buildCrossSectionSnapshots({
    candlesBySymbol: data.candlesBySymbol,
    symbols,
    startTime: WARMUP_START_OPEN,
    endTime: OUTCOME_END,
    minValidSymbols: M13_MIN_VALID_SYMBOLS,
  });
  const featureResult = buildCrossSectionalFeatures({
    snapshots: snapshotResult.snapshots,
    rejected_snapshots: snapshotResult.rejected_snapshots,
    symbols,
    windowHours: M13_BETA_WINDOW_HOURS,
  });
  const samples = buildDirectionalSamples({
    featureRows: featureResult.feature_rows,
    candlesBySymbol: data.candlesBySymbol,
    symbols,
    candidateId: 'X8-btc-eth-lead-lag-continuation',
    horizons: [...M13_HORIZONS_HOURS],
    roundTripCostPercent: M15_COST_PERCENT,
  });
  const validationSamples = recordsInValidationPeriod(samples);
  assertOutcomeCoverage(validationSamples);
  if (!validationSamples.length) throw new Error('M1.5 produced no validation records');

  const retrospective = buildRetrospectiveViews(validationSamples);
  const causal = buildCausalViews(validationSamples, {
    minValidSymbols: M15_MIN_BUCKET_CLOSE_BREADTH,
  });
  if (causal.support.eligible_events.length < M15_VALIDATION_WINDOW_COUNT) {
    throw new Error('M1.5 produced too few eligible causal bucket-close events');
  }
  const validationPlan = buildValidationWindows(causal.support.close_records);
  const windows = validationPlan.windows;
  const policyRecords = {
    [M15_POLICY_IDS.D1]: retrospective[M15_POLICY_IDS.D1],
    [M15_POLICY_IDS.D2]: retrospective[M15_POLICY_IDS.D2],
    [M15_POLICY_IDS.C1]: causal[M15_POLICY_IDS.C1],
    [M15_POLICY_IDS.C2]: causal[M15_POLICY_IDS.C2],
  };
  const evaluated = Object.fromEntries(M15_POLICY_ORDER.map(policyId => [
    policyId,
    evaluateM15Policy(policyRecords[policyId], validationPlan),
  ]));
  for (const policyId of M15_POLICY_ORDER) {
    const assignment = evaluated[policyId].assignment;
    if (assignment.dropped_in_support_policy_records !== 0) {
      throw new Error(
        'DROPPED_IN_SUPPORT_POLICY_RECORDS=' + assignment.dropped_in_support_policy_records
        + ' for ' + policyId,
      );
    }
    if (assignment.event_assignment_integrity?.pass !== true) {
      throw new Error('M1.5 event assignment integrity failed for ' + policyId);
    }
  }

  const d1Gate = evaluateD1Replication(evaluated[M15_POLICY_IDS.D1]);
  const d2Gate = evaluateD1Replication(evaluated[M15_POLICY_IDS.D2]);
  const c1Calibration = calibrationForC1(evaluated[M15_POLICY_IDS.C1].assigned_records);
  const c1Gate = evaluateC1Confirmation(evaluated[M15_POLICY_IDS.C1]);
  const c2Gate = evaluateC1Confirmation(evaluated[M15_POLICY_IDS.C2]);
  const absolutePromotion = evaluateAbsolutePromotion({
    ...evaluated[M15_POLICY_IDS.C1],
    confirmation_pass: c1Gate.pass,
  }, c1Calibration);
  const decision = resolveM15Decision({
    freshEvidenceSufficient: causal.support.eligible_events.length >= 100,
    c1Confirmation: c1Gate.pass,
    absolutePromotion: absolutePromotion.pass,
    d1Replication: d1Gate.pass,
  });

  const outcomeManifest = buildOutcomeManifest(
    evaluated[M15_POLICY_IDS.C1].assigned_records,
    symbols,
  );
  const outcomeDataManifestHash = hashConfig(outcomeManifest);
  const gateContract = {
    d1_replication: {
      events: 100,
      gross_expectancy_positive: true,
      gross_pf_gt: 1,
      standard_gross_ci95_lower_gte: 0,
      standard_gross_p_gt: 0.95,
      gross_positive_window_ratio_gte: 2 / 3,
      breadth: 8,
      concentration_lte: 0.30,
    },
    c1_confirmation: {
      events: 100,
      net_expectancy_positive: true,
      net_pf_gt: 1,
      standard_net_ci95_lower_gte: 0,
      standard_net_p_gt: 0.95,
      moving_block_net_ci95_lower_gte: 0,
      moving_block_net_p_gt: 0.95,
      net_positive_window_ratio_gte: 2 / 3,
      breadth: 8,
      concentration_lte: 0.30,
    },
    absolute_promotion: {
      net_pf_gte: 1.25,
      net_expectancy_gte: 0.15,
      windows_gte: 6,
      positive_windows_gte: 4,
      positive_ratio_gte: 2 / 3,
      calibration: 'PASS',
      breadth: 8,
      concentration_lte: 0.30,
    },
  };
  const configHash = buildM15ConfigHash({
    baseMainSha: M15_BASE_MAIN_SHA,
    m14SourceSha: M15_M14_SOURCE_SHA,
    symbols,
    validationPlanHash: validationPlan.validation_plan_hash,
    validationEventWindowMapHash: validationPlan.validation_event_window_map_hash,
    gates: gateContract,
  });

  const contract = policyContract();
  const policyReport = {};
  for (const policyId of M15_POLICY_ORDER) {
    const isD1 = policyId === M15_POLICY_IDS.D1;
    const isD2 = policyId === M15_POLICY_IDS.D2;
    const isC1 = policyId === M15_POLICY_IDS.C1;
    const gate = isD1 ? d1Gate : isD2 ? d2Gate : isC1 ? c1Gate : c2Gate;
    policyReport[policyId] = {
      ...toPolicyReport(evaluated[policyId], gate, {
        calibration: isC1 ? c1Calibration : null,
        deployable: isC1 || policyId === M15_POLICY_IDS.C2,
        secondaryOnly: policyId === M15_POLICY_IDS.C2,
      }),
      contract: contract[policyId],
      directional_slices: directionReports(policyRecords[policyId], validationPlan),
    };
  }

  const report = {
    report_version: M15_RESEARCH_VERSION,
    research_version: M15_RESEARCH_VERSION,
    experiment_id: M15_EXPERIMENT_ID,
    generated_at: new Date().toISOString(),
    repository: 'SengC-it/crypto-alerts',
    branch,
    draft_pr_number: draftPrNumber,
    base_main_sha: M15_BASE_MAIN_SHA,
    m1_4_source_sha: M15_M14_SOURCE_SHA,
    experiment_source_sha: experimentSourceSha,
    supersedes_run_version: 'm1.5-causal-sparsification-0.1.0',
    supersedes_reason: 'RETROSPECTIVE_EVENT_WINDOW_ASSIGNMENT_METHOD_ERROR',
    prior_run_status: 'INVALIDATED_METHOD_ERROR',
    prior_run_invalidated_reason: 'RETROSPECTIVE_EVENT_WINDOW_ASSIGNMENT_USED_SELECTED_RECORD_TIME',
    prior_invalidated_performance_runs: 1,
    corrected_official_performance_run_count: 1,
    candidate_id: 'X8-btc-eth-lead-lag-continuation',
    primary_horizon_hours: M15_PRIMARY_HORIZON_HOURS,
    round_trip_cost_percent: M15_COST_PERCENT,
    causal_bucket_close_min_valid_symbols: M15_MIN_BUCKET_CLOSE_BREADTH,
    configured_symbols: symbols,
    validation_data_manifest_hash: validationDataManifestHash,
    outcome_data_manifest_hash: outcomeDataManifestHash,
    config_hash: configHash,
    data_source: 'public Binance Futures archives; closed 1h candles only',
    validation: {
      signal_start: M15_VALIDATION_SIGNAL_START,
      signal_end: M15_VALIDATION_SIGNAL_END,
      outcome_data_end: M15_OUTCOME_DATA_END,
      m1_4_official_end: '2026-07-12T11:59:59.999Z',
      no_overlap_with_m1_4: true,
      validation_plan_hash: validationPlan.validation_plan_hash,
      validation_event_window_map_hash: validationPlan.validation_event_window_map_hash,
      windows,
    },
    coverage: {
      required_timeframe: '1h',
      required_coverage_percent: 100,
      per_symbol: data.coverage,
      all_symbols_full_coverage: data.coverage.every(item => item.coverage_percent === 100),
    },
    support: {
      validation_sample_count: validationSamples.length,
      snapshot_count: snapshotResult.snapshot_count,
      rejected_snapshot_count: snapshotResult.rejected_snapshot_count,
      causal_bucket_close_event_count: causal.support.eligible_events.length,
      causal_bucket_close_rejections: rejectionSummary(causal.support.rejected_events),
      min_valid_symbols_at_bucket_close: M15_MIN_BUCKET_CLOSE_BREADTH,
      eight_hour_outcome_missing_count: 0,
      policy_assignments: Object.fromEntries(M15_POLICY_ORDER.map(policyId => [
        policyId,
        evaluated[policyId].assignment,
      ])),
    },
    feature_provenance: {
      feature_version: featureResult.feature_version,
      candidate_frozen: true,
      edge_score_frozen: true,
      raw_score_fallback: true,
      derivative_features_used: false,
      derivative_admission: false,
      point_in_time: featureResult.point_in_time === true,
      future_data_used: featureResult.future_data_used === true,
      unsupported_filters: [],
    },
    selection_contract: {
      policy_count: 4,
      policy_ids: M15_POLICY_ORDER,
      alert_timestamp_is_bucket_close: true,
      outcomes_start_after_alert: true,
      no_backdating: true,
      outcome_independent_selection: true,
      causal_policy_uses_last_fully_closed_1h_snapshot: true,
      d1_d2_reuse_m14_buildDensityViews: true,
    },
    policies: policyReport,
    calibration: c1Calibration,
    gates: {
      d1_replication: d1Gate,
      d2_diagnostic_replication: d2Gate,
      c1_confirmation: c1Gate,
      c2_secondary_confirmation: c2Gate,
      absolute_promotion: absolutePromotion,
    },
    causality_gap: buildCausalityGap(
      evaluated[M15_POLICY_IDS.D1].assigned_records,
      evaluated[M15_POLICY_IDS.C1].assigned_records,
    ),
    discovery_retention: buildDiscoveryRetention(evaluated[M15_POLICY_IDS.D1]),
    decision,
    secondary_causal_signal_only: !c1Gate.pass && c2Gate.pass,
    m2_eligible_for_separate_review: decision === 'CAUSAL_SPARSIFICATION_SHADOW_CANDIDATE',
    promotion_allowed: false,
    production_deployment: false,
    official_performance_run_count: 1,
    final_holdout_outcomes_accessed: false,
    safety_flags: M15_SAFETY_FLAGS,
    bootstrap: {
      repetitions: M15_BOOTSTRAP_REPETITIONS,
      seed: M15_BOOTSTRAP_SEED,
      block_length_events: M15_MOVING_BLOCK_LENGTH,
      block_length_hours: M15_MOVING_BLOCK_LENGTH * 4,
      unit: 'independent_market_event_id',
      within_block_order_preserved: true,
    },
    limitations: [
      'Research-only result; no production route or V2 runtime was changed.',
      'C1 is the only confirmatory causal policy; C2 is secondary and cannot rescue C1.',
      'D1 and D2 are retrospective diagnostics and remain non-deployable.',
      'No alpha expansion, score retuning, threshold search, or symbol/direction/regime filter was performed.',
    ],
  };

  writeArtifact(manifestPath, validationDataManifest, true);
  writeArtifact(reportPath, report, true);
  writeArtifact(docsPath, markdownReport(report));
  console.log(JSON.stringify({
    experiment_id: M15_EXPERIMENT_ID,
    decision,
    c1_confirmation_pass: c1Gate.pass,
    absolute_promotion_pass: absolutePromotion.pass,
    config_hash: configHash,
    validation_data_manifest_hash: validationDataManifestHash,
    report_path: reportPath,
    manifest_path: manifestPath,
    docs_path: docsPath,
  }));
}

main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});

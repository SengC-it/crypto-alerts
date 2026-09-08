// Run the bounded M1.4 feasibility review. This script replays only frozen
// M1.1/M1.2/M1.3 signal lanes; it does not define or search new candidates.

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
  freezeM1DevelopmentRecords,
  prepareM11Samples,
  runM11Candidate,
} from '../src/v2/edgeDiscovery.js';
import { M12_BASELINE_CANDIDATE, runM12Candidate } from '../src/v2/informationGain.js';
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
  M13_FEATURE_VERSION,
  M13_HORIZONS_HOURS,
  M13_MIN_VALID_SYMBOLS,
  M13_PREDECLARED_CANDIDATES,
  M13_ROUND_TRIP_COST_PERCENT,
  attachCrossSectionalDerivativeRanks,
  buildCrossSectionSnapshots,
  buildCrossSectionalFeatures,
  buildDirectionalSamples,
  independentMarketEventId,
  runM13Candidate,
  scoreCrossSectionalCandidate,
  summarizeM13Records,
} from '../src/v2/crossSectional.js';
import { buildCanonicalWfoPlan } from '../src/v2/walkForward.js';
import {
  M14_COSTS_PERCENT,
  M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
  M14_EVENT_ALERT_BOOTSTRAP_SEED,
  M14_HORIZONS_HOURS,
  M14_REQUIRED_EMBARGO_HOURS,
  M14_REQUIRED_LABEL_HORIZON_HOURS,
  M14_REQUIRED_PURGE_HOURS,
  M14_REVIEW_VERSION,
  M14_SAFETY_FLAGS,
  assertReviewCalendarParity,
  buildCanonicalReviewPlan,
  buildCostMatrix,
  buildDensityViews,
  buildDirectionSlices,
  buildEventAlertObservations,
  buildLossAttribution,
  buildRegimeSlices,
  buildUniverseSlices,
  classifyDensityFeasibility,
  classifyDirectionalEdge,
  compactEventAlertEvents,
  reviewConfigHash,
  resolveFeasibilityDecision,
  spearmanIc,
  summarizeEventAlertUtility,
  summarizeReviewRecords,
} from '../src/v2/m14Review.js';

const HOUR = 60 * 60 * 1000;
const BASE_MAIN_SHA = '80f46614ee1db025ffd3c76a71ad5fb7e663bfe5';
const PREVIOUS_FINAL_HOLDOUT_BOUNDARY = M1_FROZEN_HOLDOUT.boundary_timestamp;
const PREVIOUS_FINAL_HOLDOUT_HASH = M1_FROZEN_HOLDOUT.boundary_hash;
const FROZEN_M13_FINAL_HOLDOUT_START = 1777409999999;
const GENERATION_HISTORY_CANDLES = 256;
const REQUIRED_X11_DERIVATIVE_FAMILIES = [...M12_DERIVATIVE_FAMILIES];
const DEFAULT_AS_OF = '2026-07-12T12:59:59.998Z';

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
  const numeric = finite(value);
  if (numeric === null) return null;
  return new Date(numeric).toISOString();
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function sourceReachable(sourceSha) {
  if (!sourceSha || sourceSha === 'unknown') return false;
  try {
    execFileSync('git', ['cat-file', '-e', `${sourceSha}^{commit}`], { cwd: process.cwd(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function exactConfiguredSymbols(value) {
  const symbols = (value || CONFIG.BINANCE_SYMBOLS.join(','))
    .split(',').map(symbol => symbol.toUpperCase().trim()).filter(Boolean);
  const configured = [...CONFIG.BINANCE_SYMBOLS].map(symbol => symbol.toUpperCase()).sort();
  if (symbols.length !== configured.length || [...symbols].sort().some((symbol, index) => symbol !== configured[index])) {
    throw new Error('M1.4 requires the configured 18-symbol universe without substitutions');
  }
  return symbols;
}

let requestTimeoutMs = 30000;
let maxRetries = 2;

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
        : await loadBinanceVisionCandlesLongRange({ symbol, timeframe: '1h', startTime: archiveStart, endTime: window.requestedEnd, concurrency, fetchImpl: fetchPublicArchive });
      const history = await loadBacktestHistory(symbol, days, { config: CONFIG, asOf, strictCoverage: true, candles: archive.candles });
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
  const time = finite(record?.timestamp);
  return time !== null && time >= window.startOpen && time + 48 * HOUR <= window.requestedEnd;
}

function eventDecorate(record) {
  const timestamp = finite(record.timestamp);
  const openTime = timestamp === null ? null : timestamp - HOUR + 1;
  const event = independentMarketEventId(openTime);
  return {
    ...record,
    snapshot_event_id: timestamp === null ? null : `m14-snapshot:${timestamp}`,
    independent_market_event_id: event,
    market_event_id: event,
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

function resultForReview(result, laneId, laneLabel, primaryHorizon = 8) {
  if (!result) return null;
  const records = (result.oos_records || []).map(record => ({
    ...record,
    primary_horizon_hours: finite(record.primary_horizon_hours) ?? (primaryHorizon === 'record_primary' ? null : primaryHorizon),
    independent_market_event_id: record.independent_market_event_id || record.market_event_id,
    market_event_id: record.independent_market_event_id || record.market_event_id,
    review_window_index: record.review_window_index ?? record.window_index ?? null,
  }));
  const selectedRecords = records.filter(record => record.selected === true);
  const primaryHorizons = [...new Set(records.map(record => finite(record.primary_horizon_hours)).filter(value => value !== null))];
  const lanePrimaryHorizon = primaryHorizons.length === 1 ? primaryHorizons[0] : primaryHorizon;
  return {
    lane_id: laneId,
    lane_label: laneLabel,
    primary_horizon_hours: primaryHorizon,
    frozen_record_primary_horizons: primaryHorizons,
    inferred_primary_horizon_hours: lanePrimaryHorizon,
    result,
    records,
    selected_records: selectedRecords,
    calibration: result.calibration?.status || result.metrics?.score_calibration?.status || 'UNKNOWN',
    final_holdout_untouched: result.final_holdout_untouched === true,
  };
}

function buildV1Comparator(records, bestResult) {
  const normalized = records.map(record => ({
    ...record,
    selected: true,
    primary_horizon_hours: 1,
    independent_market_event_id: record.independent_market_event_id || record.market_event_id,
    market_event_id: record.independent_market_event_id || record.market_event_id,
  }));
  return {
    oos_records: normalized,
    selected_records: normalized,
    metrics: summarizeM13Records(normalized, { primaryHorizonHours: 8 }),
    walk_forward: bestResult?.walk_forward || null,
    final_holdout_untouched: bestResult?.final_holdout_untouched === true,
  };
}

function attachWindowIndexes(records, windows) {
  return records.map(record => {
    if (record.review_window_index !== null && record.review_window_index !== undefined) return record;
    const time = finite(record.timestamp);
    const window = windows.find(item => time !== null && time >= item.test_start_timestamp && time <= item.test_end_timestamp);
    return { ...record, review_window_index: window?.index ?? null };
  });
}

function reportLane(lane, windows) {
  const records = attachWindowIndexes(lane.records, windows);
  const selected = attachWindowIndexes(lane.selected_records, windows);
  const primaryHorizon = lane.inferred_primary_horizon_hours ?? lane.primary_horizon_hours;
  const directional = classifyDirectionalEdge(selected, {
    horizonHours: primaryHorizon,
    windows,
    calibration: lane.calibration,
    repetitions: M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
    seed: M14_EVENT_ALERT_BOOTSTRAP_SEED,
  });
  const directions = Object.fromEntries(Object.entries(buildDirectionSlices(selected)).map(([direction, values]) => [
    direction,
    summarizeReviewRecords(values, { horizonHours: 8, costPercent: 0.14, windows }),
  ]));
  const regimes = Object.fromEntries(Object.entries(buildRegimeSlices(selected)).map(([regime, values]) => [
    regime,
    summarizeReviewRecords(values, { horizonHours: 8, costPercent: 0.14, windows }),
  ]));
  const universe = buildUniverseSlices(selected, {
    tier1: CONFIG.MONITOR_TIERS.tier1.symbols,
    tier2: CONFIG.MONITOR_TIERS.tier2.symbols,
    tier3: CONFIG.MONITOR_TIERS.tier3.symbols,
  });
  const densityValues = buildDensityViews(records);
  const densityViews = Object.fromEntries(Object.entries(densityValues).map(([name, values]) => [
    name,
    summarizeReviewRecords(values, { horizonHours: 8, costPercent: 0.14, windows }),
  ]));
  const densityFeasibility = Object.fromEntries(Object.entries(densityValues).map(([name, values]) => [
    name,
    classifyDensityFeasibility(values, {
      horizonHours: 8,
      windows,
      repetitions: M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
      seed: M14_EVENT_ALERT_BOOTSTRAP_SEED,
    }),
  ]));
  const primaryGrossSummary = directional.gross_summary;
  const primaryNetSummary = directional.net_summary;
  return {
    ...lane,
    records,
    selected_records: selected,
    primary_horizon_hours: primaryHorizon,
    summary: primaryNetSummary,
    all_oos_summary: summarizeReviewRecords(records, { horizonHours: primaryHorizon, costPercent: 0.14, windows }),
    primary_gross_expectancy: primaryGrossSummary.gross_expectancy_percent,
    primary_net_expectancy: primaryNetSummary.net_expectancy_percent,
    primary_gross_pf: primaryGrossSummary.gross_pf,
    primary_net_pf: primaryNetSummary.net_pf,
    primary_gross_positive_windows: primaryGrossSummary.gross_positive_windows,
    primary_net_positive_windows: primaryNetSummary.net_positive_windows,
    primary_gross_positive_window_ratio: primaryGrossSummary.gross_positive_window_ratio,
    primary_net_positive_window_ratio: primaryNetSummary.net_positive_window_ratio,
    gross_bootstrap: directional.gross_bootstrap,
    net_bootstrap: directional.net_bootstrap,
    gross_edge_classification: directional.classification,
    cost_matrix: buildCostMatrix(selected, { horizons: M14_HORIZONS_HOURS, costs: M14_COSTS_PERCENT, windows }),
    horizon_surface: Object.fromEntries(M14_HORIZONS_HOURS.map(horizon => [
      `${horizon}h`, summarizeReviewRecords(selected, { horizonHours: horizon, costPercent: 0.14, windows }),
    ])),
    density_views: densityViews,
    density_feasibility: densityFeasibility,
    universe_slices: Object.fromEntries(Object.entries(universe).map(([name, values]) => [
      name,
      summarizeReviewRecords(values, { horizonHours: 8, costPercent: 0.14, windows }),
    ])),
    direction_slices: directions,
    regime_slices: regimes,
    ic: spearmanIc(selected, { horizonHours: 8, windows }),
    directional_classification: directional,
    loss_attribution: buildLossAttribution(primaryNetSummary, {
      buySummary: directions.BUY,
      sellSummary: directions.SELL,
      calibration: lane.calibration,
    }),
  };
}

function compactStageReport(report = {}) {
  const candidates = report.candidates || [];
  return {
    experiment_id: report.experiment_id || null,
    model_version: report.model_version || null,
    feature_version: report.feature_version || null,
    decision: report.decision || null,
    candidate_count: candidates.length,
    evaluated_count: candidates.filter(candidate => candidate.status !== 'NOT_EVALUATED_DATA_NOT_ADMITTED').length,
    failed_count: candidates.filter(candidate => {
      const promotion = candidate.promotion || candidate.absolute_gate || {};
      return promotion.pass === false || promotion.recommendation === 'REJECT' || candidate.status === 'NOT_EVALUATED_DATA_NOT_ADMITTED';
    }).length,
    candidates: candidates.map(candidate => {
      const metrics = candidate.metrics || candidate;
      const stability = candidate.stability || {};
      const promotion = candidate.promotion || candidate.absolute_gate || {};
      return {
        candidate_id: candidate.candidate_id || candidate.id || null,
        status: candidate.status || 'EVALUATED',
        gross_pf: metrics.gross_profit_factor ?? metrics.gross_pf ?? null,
        net_pf: metrics.net_profit_factor ?? metrics.net_pf ?? null,
        gross_expectancy_percent: metrics.gross_expectancy_percent ?? metrics.gross_exp ?? null,
        net_expectancy_percent: metrics.net_expectancy_percent ?? metrics.net_exp ?? null,
        positive_windows: metrics.positive_windows ?? stability.positive_windows ?? null,
        total_windows: metrics.total_windows ?? stability.total_windows ?? null,
        positive_window_ratio: metrics.positive_window_ratio ?? stability.positive_window_ratio ?? null,
        calibration: metrics.score_calibration?.status || candidate.calibration || null,
        direction_results: compactMap(metrics.direction_breadth || {}),
        regime_results: compactMap(metrics.trend_regime_breadth || metrics.volatility_breadth || {}),
        promotion_pass: promotion.pass ?? (promotion.recommendation === 'PROMOTE'),
      };
    }),
  };
}

function compactMap(value) {
  return Object.fromEntries(Object.entries(value || {}).map(([key, item]) => [key, {
    sample_count: item.sample_count ?? item.count ?? null,
    independent_events: item.independent_market_events ?? item.independent_clusters ?? null,
    gross_pf: item.gross_profit_factor ?? item.gross_pf ?? null,
    net_pf: item.net_profit_factor ?? item.net_pf ?? null,
    gross_expectancy_percent: item.gross_expectancy_percent ?? null,
    net_expectancy_percent: item.net_expectancy_percent ?? null,
    hit_rate_percent: item.hit_rate_percent ?? null,
    positive_windows: item.positive_windows ?? null,
    calibration: item.score_calibration?.status || item.calibration || null,
  }]));
}

function compactSummary(summary = {}) {
  const fields = [
    'signal_count', 'independent_events', 'symbol_breadth', 'direction_breadth',
    'gross_expectancy_percent', 'net_expectancy_percent', 'gross_pf', 'net_pf',
    'hit_rate_percent', 'false_positive_rate_percent', 'avg_mfe_percent', 'avg_mae_percent',
    'gross_positive_windows', 'gross_positive_window_ratio',
    'net_positive_windows', 'net_positive_window_ratio',
    'positive_windows', 'total_windows', 'positive_window_ratio',
    'max_symbol_event_concentration', 'unique_event_symbol_concentration', 'max_symbol_record_concentration',
    'horizon_hours', 'cost_percent',
  ];
  return Object.fromEntries(fields.filter(field => summary[field] !== undefined).map(field => [field, summary[field]]));
}

function compactCostMatrix(matrix = []) {
  return matrix.map(surface => ({
    horizon_hours: surface.horizon_hours,
    costs: surface.costs.map(item => ({
      cost_percent: item.cost_percent,
      gross_expectancy_percent: item.gross_expectancy_percent,
      net_expectancy_percent: item.net_expectancy_percent,
      gross_pf: item.gross_pf,
      net_pf: item.net_pf,
      cost_drag_percent: item.cost_drag_percent,
      gross_edge_consumed_percent: item.gross_edge_consumed_percent,
      break_even_round_trip_cost: item.break_even_round_trip_cost,
    })),
  }));
}

function compactLane(lane) {
  const compactSlices = slices => Object.fromEntries(Object.entries(slices || {}).map(([name, summary]) => [name, compactSummary(summary)]));
  return {
    lane_id: lane.lane_id,
    lane_label: lane.lane_label,
    primary_horizon_hours: lane.primary_horizon_hours,
    primary_gross_expectancy: lane.primary_gross_expectancy,
    primary_net_expectancy: lane.primary_net_expectancy,
    primary_gross_pf: lane.primary_gross_pf,
    primary_net_pf: lane.primary_net_pf,
    primary_gross_positive_windows: lane.primary_gross_positive_windows,
    primary_net_positive_windows: lane.primary_net_positive_windows,
    primary_gross_positive_window_ratio: lane.primary_gross_positive_window_ratio,
    primary_net_positive_window_ratio: lane.primary_net_positive_window_ratio,
    gross_bootstrap: lane.gross_bootstrap,
    net_bootstrap: lane.net_bootstrap,
    gross_edge_classification: lane.gross_edge_classification,
    calibration: lane.calibration,
    final_holdout_untouched: lane.final_holdout_untouched,
    summary: compactSummary(lane.summary),
    all_oos_summary: compactSummary(lane.all_oos_summary),
    cost_matrix: compactCostMatrix(lane.cost_matrix),
    horizon_surface: Object.fromEntries(Object.entries(lane.horizon_surface || {}).map(([key, summary]) => [key, compactSummary(summary)])),
    density_views: compactSlices(lane.density_views),
    density_feasibility: lane.density_feasibility,
    universe_slices: compactSlices(lane.universe_slices),
    direction_slices: compactSlices(lane.direction_slices),
    regime_slices: compactSlices(lane.regime_slices),
    ic: lane.ic,
    directional_classification: {
      classification: lane.directional_classification.classification,
      robust_gross_edge: lane.directional_classification.robust_gross_edge,
      net_directional_edge: lane.directional_classification.net_directional_edge,
      gross_bootstrap: lane.directional_classification.gross_bootstrap,
      net_bootstrap: lane.directional_classification.net_bootstrap,
      gross_summary: compactSummary(lane.directional_classification.gross_summary),
      net_summary: compactSummary(lane.directional_classification.net_summary),
    },
    loss_attribution: lane.loss_attribution,
  };
}

function classifyHorizonPattern(surface = {}) {
  const rows = Object.entries(surface).map(([horizon, summary]) => ({
    horizon: Number.parseInt(horizon, 10),
    positive: summary.gross_expectancy_percent > 0 && summary.gross_pf > 1,
    gross: summary.gross_expectancy_percent,
  }));
  const positive = rows.filter(row => row.positive).map(row => row.horizon);
  if (!positive.length) return 'NONE';
  if (positive.length !== rows.filter(row => row.gross !== null).length) return 'UNSTABLE';
  if (positive.every(horizon => horizon <= 4)) return 'SHORT';
  if (positive.every(horizon => horizon >= 24)) return 'LONG';
  if (positive.every(horizon => horizon >= 4 && horizon <= 12)) return 'MEDIUM';
  return 'UNSTABLE';
}

function bestDiagnosticHorizon(surface = {}) {
  return Object.entries(surface)
    .map(([horizon, summary]) => ({ horizon: Number.parseInt(horizon, 10), gross: summary.gross_expectancy_percent }))
    .filter(item => item.gross !== null)
    .sort((left, right) => right.gross - left.gross || left.horizon - right.horizon)[0]?.horizon ?? null;
}

function buildMarkdown(report) {
  const tick = String.fromCharCode(96);
  const lines = [
    '# M1.4 Alpha Feasibility & Signal Utility Review',
    '',
    `Decision: **${report.decision}**`,
    '',
    `- Base main SHA: ${tick}${report.base_main_sha}${tick}; experiment source SHA: ${tick}${report.experiment_source_sha}${tick}.`,
    `- Review version: ${tick}${report.review_version}${tick}; experiment: ${tick}${report.experiment_id}${tick}.`,
    `- Data: ${report.data_source}; ${report.historical_target}.`,
    `- Final holdout untouched: **${report.final_holdout_untouched}**; outcomes accessed: **${report.final_holdout_outcomes_accessed}**.`,
    '',
    '## Frozen review lanes',
    '',
    '| Lane | Role | Primary horizon | Signals | Events | Gross expectancy | Net expectancy | Gross PF | Net PF | Classification |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---|',
  ];
  for (const lane of Object.values(report.review_lanes || {})) {
    const summary = lane.summary || {};
    lines.push(`| ${lane.lane_id} | ${lane.lane_label} | ${lane.primary_horizon_hours} | ${summary.signal_count ?? 0} | ${summary.independent_events ?? 0} | ${lane.primary_gross_expectancy ?? 'N/A'}% | ${lane.primary_net_expectancy ?? 'N/A'}% | ${lane.primary_gross_pf ?? 'N/A'} | ${lane.primary_net_pf ?? 'N/A'} | ${lane.gross_edge_classification || 'N/A'} |`);
  }
  lines.push('', '## Density feasibility', '', `- Frozen-lane robust gross edge: **${report.FROZEN_LANE_ROBUST_GROSS_EDGE}**.`, `- Any density robust gross edge: **${report.DENSITY_ROBUST_GROSS_EDGE}**.`, '');
  lines.push('| Density view | Gross expectancy | Net expectancy | Gross PF | Net PF | Gross positive windows | Net positive windows | Events | Unique concentration | Gross CI95 | P(gross > 0) | Robust gross |', '|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|');
  for (const [name, density] of Object.entries(report.density_feasibility || {})) {
    lines.push(`| ${name} | ${density.gross_expectancy_percent}% | ${density.net_expectancy_percent}% | ${density.gross_pf} | ${density.net_pf} | ${density.gross_positive_windows}/${density.gross_positive_window_ratio} | ${density.net_positive_windows}/${density.net_positive_window_ratio} | ${density.independent_events} | ${density.unique_event_symbol_concentration} | ${JSON.stringify(density.gross_bootstrap?.ci95)} | ${density.gross_bootstrap?.p_gt_zero} | ${density.DENSITY_ROBUST_GROSS_EDGE} |`);
  }
  lines.push('', '## Calendar parity', '', '```json', JSON.stringify(report.calendar_parity, null, 2), '```', '', '## Event alert utility', '', '```json', JSON.stringify(report.event_alert_utility, null, 2), '```', '', '## Feasibility matrix', '', '| Dimension | Result | Evidence | Implication |', '|---|---|---|---|');
  for (const row of report.feasibility_matrix || []) lines.push(`| ${row.dimension} | ${row.result} | ${row.evidence} | ${row.implication} |`);
  lines.push('', '## Known limitations', '');
  for (const limitation of report.known_limitations || []) lines.push(`- ${limitation}`);
  lines.push('');
  return lines.join('\n');
}

const requestedDaysArgument = Number(argument('days', '365'));
if (!Number.isFinite(requestedDaysArgument) || requestedDaysArgument < 180) throw new Error(`M1.4 requires 365d target; received ${requestedDaysArgument}`);
const symbols = exactConfiguredSymbols(argument('symbols', CONFIG.BINANCE_SYMBOLS.join(',')));
const requestedAsOf = argument('as-of', DEFAULT_AS_OF);
const parsedAsOf = Date.parse(requestedAsOf);
if (!Number.isFinite(parsedAsOf)) throw new Error(`Invalid --as-of value: ${requestedAsOf}`);
const source = hasFlag('fixture') ? 'deterministic_test_fixture' : 'public_binance_futures_archive';
const fixture = hasFlag('fixture');
const concurrency = Math.max(1, Number(argument('concurrency', '8')) || 8);
const symbolConcurrency = Math.max(1, Number(argument('symbol-concurrency', '2')) || 2);
requestTimeoutMs = Math.max(1000, Number(argument('request-timeout-ms', '30000')) || 30000);
maxRetries = Math.max(0, Number(argument('max-retries', '2')) || 2);
const experimentSourceSha = argument('experiment-source-sha') || argument('commit-sha') || getCommitSha();
const outputPath = path.resolve(argument('out', 'reports/m1-4-alpha-feasibility.json'));
const markdownPath = path.resolve(argument('report-out', 'docs/m1-4-alpha-feasibility.md'));
const experimentDate = new Date(parsedAsOf).toISOString().slice(0, 10);
const experimentId = argument('experiment', `m1.4-${source}-${experimentDate}-${M14_REVIEW_VERSION}`);

const loaded = await loadWithMinimumCoverage(symbols, requestedDaysArgument, parsedAsOf, concurrency, symbolConcurrency, fixture);
const { window, histories } = loaded;
const requestedDays = window.expected / 24;
const coverage = histories.map(item => item.coverage);
const coverageComplete = coverage.length === symbols.length && coverage.every(item => item.coverage_percent === 100 && item.missing_candles === 0);
if (!coverageComplete) throw new Error('M1.4 strict per-symbol candle coverage failed');
const candleHistoryBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.candles]));
const researchCandlesBySymbol = Object.fromEntries(histories.map(item => [item.symbol, item.researchCandles]));

const generated = generateHistoricalResearchRecords({
  candlesBySymbol: candleHistoryBySymbol,
  config: CONFIG,
  asOf: parsedAsOf,
  dataSource: source,
  roundTripCostPercent: M13_ROUND_TRIP_COST_PERCENT,
  lineageOptions: { commitSha: experimentSourceSha, modelVersion: M14_REVIEW_VERSION },
  generationHistoryCandles: GENERATION_HISTORY_CANDLES,
  includeArtifacts: false,
});
const developmentV2 = generated.v2_research_records.filter(record => finite(record.timestamp) !== null && finite(record.timestamp) < PREVIOUS_FINAL_HOLDOUT_BOUNDARY);
const developmentV1 = generated.v1_research_records.filter(record => finite(record.timestamp) !== null && finite(record.timestamp) < PREVIOUS_FINAL_HOLDOUT_BOUNDARY);
const m11Samples = prepareM11Samples(
  freezeM1DevelopmentRecords(developmentV2, PREVIOUS_FINAL_HOLDOUT_BOUNDARY),
  { maximumLabelHorizonHours: 48, boundaryTimestamp: PREVIOUS_FINAL_HOLDOUT_BOUNDARY },
).filter(record => inResearchRange(record, window)).map(eventDecorate);
const m11V1Records = developmentV1.filter(record => inResearchRange(record, window)).map(eventDecorate);
if (generated.v2_research_records.some(record => finite(record.timestamp) !== null && finite(record.timestamp) >= PREVIOUS_FINAL_HOLDOUT_BOUNDARY)) {
  throw new Error('M1.4 input unexpectedly contains previous final holdout rows');
}
generated.normalizedBySymbol = null;
generated.rankedV2 = null;
generated.v2Records = null;
generated.v1Records = null;

const snapshotStart = window.startOpen - M13_BETA_WINDOW_HOURS * HOUR;
const snapshotResult = buildCrossSectionSnapshots({ candlesBySymbol: researchCandlesBySymbol, symbols, startTime: snapshotStart, endTime: window.requestedEnd, minValidSymbols: M13_MIN_VALID_SYMBOLS });
const featureResult = buildCrossSectionalFeatures({ ...snapshotResult, windowHours: M13_BETA_WINDOW_HOURS, minimumObservations: 120 });
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
  derivativeHistory = await loadPublicDerivativeHistory({
    symbols,
    startTime: window.requestedStart - M13_BETA_WINDOW_HOURS * HOUR,
    endTime: window.requestedEnd,
    concurrency,
    symbolConcurrency,
    requestTimeoutMs,
    maxRetries,
    fetchImpl: fetchPublicArchive,
  });
  derivativeDatasets = {
    fundingBySymbol: derivativeHistory.fundingBySymbol,
    openInterestBySymbol: derivativeHistory.openInterestBySymbol,
    premiumBySymbol: derivativeHistory.premiumBySymbol,
    candlesBySymbol: researchCandlesBySymbol,
  };
  dataAdmission = buildDataAdmissionReport({ symbols, startTime: window.requestedStart, endTime: window.requestedEnd, datasets: derivativeDatasets, source, coverageThreshold: M12_MIN_COVERAGE });
}

let featureRows = featureResult.features.filter(row => row.timestamp >= window.startOpen && row.timestamp + 48 * HOUR <= window.requestedEnd);
if (derivativeDatasets) {
  featureRows = attachPointInTimeDerivativeFeatures(featureRows, derivativeDatasets);
  attachCrossSectionalDerivativeRanks(featureRows, { families: REQUIRED_X11_DERIVATIVE_FAMILIES });
}
const frozenCanonicalBoundaryPresent = featureRows.some(row => row.timestamp === FROZEN_M13_FINAL_HOLDOUT_START);
if (!fixture && !frozenCanonicalBoundaryPresent) throw new Error(`M1.4 canonical final holdout boundary is missing: ${FROZEN_M13_FINAL_HOLDOUT_START}`);
const canonicalWfoPlan = buildCanonicalWfoPlan(featureRows, {
  finalHoldoutStartTimestamp: frozenCanonicalBoundaryPresent ? FROZEN_M13_FINAL_HOLDOUT_START : null,
  trainRatio: 0.35,
  testRatio: 0.06,
  holdoutRatio: 0.20,
  purgeHours: M14_REQUIRED_PURGE_HOURS,
  embargoHours: M14_REQUIRED_EMBARGO_HOURS,
  labelHorizonHours: M14_REQUIRED_LABEL_HORIZON_HOURS,
  minimumWindows: 6,
  includeFinalHoldoutOutcomeInHash: false,
});
const canonicalReviewPlan = buildCanonicalReviewPlan({
  sourceTimelineStart: featureRows[0]?.timestamp ?? null,
  sourceTimelineEnd: featureRows.at(-1)?.timestamp ?? null,
  finalHoldoutStart: canonicalWfoPlan.final_holdout_start,
  windows: canonicalWfoPlan.windows,
});
const commonWfoOptions = { purgeHours: 48, embargoHours: 24, labelHorizonHours: 48, minimumWindows: 6, canonicalPlan: canonicalWfoPlan };
const m11Result = runM11Candidate(m11Samples, { candidateId: M12_BASELINE_CANDIDATE.candidate_id, candidate: M12_BASELINE_CANDIDATE, dataSource: source, wfoOptions: commonWfoOptions });
const baseCrossSectionalSamples = buildDirectionalSamples({ featureRows, candlesBySymbol: researchCandlesBySymbol, candidateId: 'X1-relative-momentum', roundTripCostPercent: M13_ROUND_TRIP_COST_PERCENT, horizons: M13_HORIZONS_HOURS });
const x8Candidate = M13_PREDECLARED_CANDIDATES.find(candidate => candidate.candidate_id === 'X8-btc-eth-lead-lag-continuation');
const x8Samples = repriceSamples(baseCrossSectionalSamples, x8Candidate);
const x8Result = runM13Candidate(x8Samples, { candidateId: x8Candidate.candidate_id, candidate: x8Candidate, dataSource: source, wfoOptions: commonWfoOptions });

let m12Result = null;
if (derivativeDatasets && dataAdmission.admitted_families.includes('Funding') && dataAdmission.admitted_families.includes('Basis/Premium')) {
  const enrichedM11Samples = attachPointInTimeDerivativeFeatures(m11Samples, derivativeDatasets);
  m12Result = runM12Candidate(enrichedM11Samples, {
    candidateId: 'C7-funding-plus-basis-premium',
    candidate: { candidate_id: 'C7-funding-plus-basis-premium', base_candidate: M12_BASELINE_CANDIDATE, derivative_families: ['Funding', 'Basis/Premium'] },
    dataSource: source,
    wfoOptions: commonWfoOptions,
  });
}

const x8Records = (x8Result.oos_records || []).map(record => ({
  ...record,
  forward_returns: record.forward_returns || {},
  net_forward_returns: record.net_forward_returns || {},
  primary_horizon_hours: 4,
}));
const lanes = [
  resultForReview(m11Result, 'R1', 'M1.1 frozen final diagnostic lane', 'record_primary'),
  m12Result ? resultForReview(m12Result, 'R2', 'M1.2 frozen final diagnostic lane', 'record_primary') : null,
  resultForReview({ ...x8Result, oos_records: x8Records }, 'R3', 'M1.3 X8 BTC/ETH lead-lag continuation', 4),
].filter(Boolean);
const v1Result = buildV1Comparator(m11V1Records, x8Result);
lanes.unshift(resultForReview(v1Result, 'R0', 'V1 production/frozen baseline', 1));
for (const lane of lanes) lane.review_plan = canonicalReviewPlan;
const calendarParity = assertReviewCalendarParity(lanes);
const reviewedLanes = lanes.map(lane => reportLane(lane, canonicalReviewPlan.windows));

const primaryLane = reviewedLanes.find(lane => lane.lane_id === 'R3') || reviewedLanes[0];
const alertEvents8h = buildEventAlertObservations(primaryLane.selected_records, {
  candlesBySymbol: researchCandlesBySymbol,
  snapshots: snapshotResult.snapshots,
  horizonHours: 8,
  windows: canonicalReviewPlan.windows,
});
const alertEvents4h = buildEventAlertObservations(primaryLane.selected_records, {
  candlesBySymbol: researchCandlesBySymbol,
  snapshots: snapshotResult.snapshots,
  horizonHours: 4,
  windows: canonicalReviewPlan.windows,
});
const alertEvents24h = buildEventAlertObservations(primaryLane.selected_records, {
  candlesBySymbol: researchCandlesBySymbol,
  snapshots: snapshotResult.snapshots,
  horizonHours: 24,
  windows: canonicalReviewPlan.windows,
});
const alertUtility8h = summarizeEventAlertUtility(alertEvents8h, {
  windows: canonicalReviewPlan.windows,
  repetitions: M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
  seed: M14_EVENT_ALERT_BOOTSTRAP_SEED,
});
const alertUtility4h = summarizeEventAlertUtility(alertEvents4h, {
  windows: canonicalReviewPlan.windows,
  repetitions: M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
  seed: M14_EVENT_ALERT_BOOTSTRAP_SEED,
});
const alertUtility24h = summarizeEventAlertUtility(alertEvents24h, {
  windows: canonicalReviewPlan.windows,
  repetitions: M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
  seed: M14_EVENT_ALERT_BOOTSTRAP_SEED,
});

const stageEvidence = {};
for (const [stage, file] of Object.entries({
  M1: 'reports/m1-final.json',
  M1_1: 'reports/m1-1-final.json',
  M1_2: 'reports/m1-2-final-0.1.1.json',
  M1_3: 'reports/m1-3-final.json',
})) {
  const filePath = path.resolve(file);
  stageEvidence[stage] = fs.existsSync(filePath)
    ? compactStageReport(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    : { status: 'MISSING_FROZEN_REPORT', file };
}

const frozenLaneRobustGrossEdge = reviewedLanes.some(lane => lane.directional_classification.robust_gross_edge === true);
const densityFeasibility = primaryLane.density_feasibility;
const densityRobustGrossEdge = Object.values(densityFeasibility).some(item => item.DENSITY_ROBUST_GROSS_EDGE === true);
const directionalResearchSignal = frozenLaneRobustGrossEdge || densityRobustGrossEdge;
const directionalGrossEdge = directionalResearchSignal;
const directionalNetEdge = reviewedLanes.some(lane => lane.directional_classification.net_directional_edge === true);
const decision = resolveFeasibilityDecision({
  frozenLaneRobustGrossEdge,
  densityRobustGrossEdge,
  eventAlertUtilityPass: alertUtility8h.gate_pass,
});
const primaryClassification = primaryLane.directional_classification.classification;
const primaryGross = primaryLane.primary_gross_expectancy;
const primaryNet = primaryLane.primary_net_expectancy;
const primaryBreakEven = primaryGross > 0 ? primaryGross : 'NO_POSITIVE_GROSS_EDGE';
const tierDiagnosticsOnly = true;
const feasibilityMatrix = [
  { dimension: 'Frozen-lane robust gross edge', result: frozenLaneRobustGrossEdge, evidence: `${reviewedLanes.length} frozen lanes at their declared primary horizons`, implication: 'No frozen lane alone justifies continuation unless this passes' },
  { dimension: 'Density robust gross edge', result: densityRobustGrossEdge, evidence: 'Three predeclared density diagnostics at fixed 8h', implication: 'Feasibility signal only; no density promotion' },
  { dimension: 'Directional research signal', result: directionalResearchSignal, evidence: 'Frozen-lane OR density robust gross gate', implication: 'At most one separately designed future validation stage' },
  { dimension: 'Directional net edge', result: directionalNetEdge, evidence: 'Fixed 0.14% gate and existing promotion criteria', implication: 'No production promotion' },
  { dimension: 'Cost sensitivity', result: primaryClassification, evidence: `R3 ${primaryLane.primary_horizon_hours}h primary gross=${primaryGross}% net=${primaryNet}%`, implication: 'Diagnostic only; no cost-based retuning' },
  { dimension: 'Horizon stability', result: classifyHorizonPattern(primaryLane.horizon_surface), evidence: `R3 ${M14_HORIZONS_HOURS.join('/')}h surface`, implication: 'Descriptive only' },
  { dimension: 'Signal density', result: 'DIAGNOSTIC_ONLY', evidence: 'Three predeclared density views', implication: 'No density policy deployment' },
  { dimension: 'BUY quality', result: primaryLane.direction_slices.BUY?.net_expectancy_percent ?? null, evidence: 'R3 BUY OOS slice', implication: 'BUY remains enabled for research/alerts' },
  { dimension: 'SELL quality', result: primaryLane.direction_slices.SELL?.net_expectancy_percent ?? null, evidence: 'R3 SELL OOS slice', implication: 'SELL remains enabled for research/alerts' },
  { dimension: 'Universe robustness', result: 'DIAGNOSTIC_ONLY', evidence: 'Tier1/Tier2/Tier3/Tier1+Tier2/All18', implication: 'No whitelist or symbol removal' },
  { dimension: 'Regime robustness', result: 'DIAGNOSTIC_ONLY', evidence: 'Bull/Bear/Sideways and Low/Normal/High/Extreme', implication: 'No regime production rule' },
  { dimension: 'Score calibration', result: primaryLane.calibration, evidence: 'Frozen OOS score bins', implication: 'No probability interpretation' },
  { dimension: 'Microstructure value', result: stageEvidence.M1_2.decision || 'NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN', evidence: 'M1.2 complete candidate distribution', implication: 'No derivative alpha expansion' },
  { dimension: 'Cross-sectional value', result: stageEvidence.M1_3.decision || 'NO_ROBUST_CROSS_SECTIONAL_ALPHA', evidence: 'M1.3 complete X0-X11 distribution', implication: 'No new cross-sectional candidates' },
  { dimension: 'Event/magnitude alert value', result: alertUtility8h.gate_pass, evidence: `8h delta=${alertUtility8h.delta_8h_absolute_return}; CI=${JSON.stringify(alertUtility8h.delta_8h_ci95)}`, implication: alertUtility8h.gate_pass ? 'Retain signal-only alert pivot' : 'Keep monitoring/research platform without event-utility claim' },
  { dimension: 'Public-data limitation', result: 'TESTED_PUBLIC_BINANCE_DATA_ONLY', evidence: 'Closed 1h candles, 18 configured symbols', implication: 'Absence of demonstrated edge is protocol-bounded, not impossibility proof' },
  { dimension: 'Final holdout status', result: true, evidence: 'Boundary/hash metadata only', implication: 'No holdout selection or conclusion leakage' },
];

const finalHoldout = {
  count: x8Result.walk_forward?.final_holdout_count ?? null,
  start: x8Result.walk_forward?.final_holdout_start ?? canonicalReviewPlan.final_holdout_start,
  hash: x8Result.walk_forward?.final_holdout_hash ?? null,
  boundary_hash: PREVIOUS_FINAL_HOLDOUT_HASH,
  outcomes_accessed_for_selection: false,
  untouched: reviewedLanes.every(lane => lane.final_holdout_untouched === true),
};
const configHash = reviewConfigHash({
  baseMainSha: BASE_MAIN_SHA,
  symbols,
  lanes,
  calendarHash: canonicalReviewPlan.canonical_review_plan_hash,
});
const report = {
  base_main_sha: BASE_MAIN_SHA,
  branch: argument('branch', 'feat/alpha-feasibility-review'),
  draft_pr_number: finite(argument('draft-pr-number', null)),
  review_version: M14_REVIEW_VERSION,
  experiment_id: experimentId,
  experiment_source_sha: experimentSourceSha,
  experiment_source_reachable: sourceReachable(experimentSourceSha),
  config_hash: configHash,
  data_source: source,
  historical_target: `${requestedDaysArgument}d target; ${requestedDays}d accepted × ${symbols.length} configured symbols`,
  accepted_days: requestedDays,
  date_range: { start: iso(window.requestedStart), end: iso(window.requestedEnd), as_of: iso(parsedAsOf) },
  symbols,
  coverage,
  coverage_complete: coverageComplete,
  valid_cross_sectional_snapshots: snapshotResult.snapshot_count,
  rejected_breadth_snapshots: snapshotResult.rejected_snapshot_count,
  independent_market_events: new Set(featureRows.map(row => row.independent_market_event_id).filter(Boolean)).size,
  event_definition: 'fixed UTC 4h bucket from closed 1h candle open time',
  data_admission: {
    admitted_families: dataAdmission.admitted_families,
    rejected_families: dataAdmission.rejected_families,
    x11_status: dataAdmission.admitted_families.length === REQUIRED_X11_DERIVATIVE_FAMILIES.length
      && REQUIRED_X11_DERIVATIVE_FAMILIES.every(family => dataAdmission.admitted_families.includes(family))
      ? 'EVALUATED' : 'NOT_EVALUATED_DATA_NOT_ADMITTED',
  },
  stage_evidence: stageEvidence,
  review_lanes: reviewedLanes.map(compactLane),
  canonical_review_plan: {
    ...canonicalReviewPlan,
    windows: canonicalReviewPlan.windows,
  },
  canonical_review_plan_hash: canonicalReviewPlan.canonical_review_plan_hash,
  calendar_parity: {
    ...calendarParity,
    canonical_wfo_plan_hash: canonicalWfoPlan.canonical_plan_hash,
    canonical_wfo_window_count: canonicalWfoPlan.windows.length,
    final_holdout_outcomes_accessed: false,
  },
  FROZEN_LANE_ROBUST_GROSS_EDGE: frozenLaneRobustGrossEdge,
  frozen_lane_robust_gross_edge: frozenLaneRobustGrossEdge,
  density_diagnostic_horizon_hours: 8,
  density_feasibility: densityFeasibility,
  DENSITY_ROBUST_GROSS_EDGE: densityRobustGrossEdge,
  density_robust_gross_edge: densityRobustGrossEdge,
  DIRECTIONAL_RESEARCH_SIGNAL: directionalResearchSignal,
  directional_research_signal: directionalResearchSignal,
  event_alert_utility: {
    primary_horizon_hours: 8,
    gate: 'EVENT_ALERT_UTILITY_GATE',
    pass: alertUtility8h.gate_pass,
    independent_events: alertUtility8h.event_count,
    delta_8h_absolute_return: alertUtility8h.delta_8h_absolute_return,
    delta_8h_ci95: alertUtility8h.delta_8h_ci95,
    p_delta_gt_zero: alertUtility8h.p_delta_gt_zero,
    positive_windows: alertUtility8h.positive_windows,
    oos_windows: alertUtility8h.oos_windows,
    positive_window_ratio: alertUtility8h.positive_window_ratio,
    symbol_breadth: alertUtility8h.symbol_breadth,
    max_symbol_event_concentration: alertUtility8h.max_symbol_event_concentration,
    bootstrap: alertUtility8h.bootstrap,
    failure_reasons: alertUtility8h.gate_failures,
    secondary_horizons: { '4h': alertUtility4h, '24h': alertUtility24h },
    event_values: compactEventAlertEvents(alertEvents8h),
    same_timestamp_outcome_independent: true,
    trading_profitability_claim: false,
  },
  cost_assumptions: {
    primary_round_trip_percent: 0.14,
    diagnostic_round_trip_percent: M14_COSTS_PERCENT,
    sensitivity_not_used_for_selection: true,
  },
  primary_lane: primaryLane.lane_id,
  primary_0_14_percent_net_result: primaryNet,
  primary_0_14_percent_gross_result: primaryGross,
  primary_break_even_round_trip_cost: primaryBreakEven,
  horizon_edge_pattern: classifyHorizonPattern(primaryLane.horizon_surface),
  best_diagnostic_horizon: bestDiagnosticHorizon(primaryLane.horizon_surface),
  DIAGNOSTIC_ONLY: true,
  directional_gross_edge: directionalGrossEdge,
  directional_net_edge: directionalNetEdge,
  cost_classification: primaryClassification,
  universe_concentration_diagnostic_only: tierDiagnosticsOnly,
  final_holdout: finalHoldout,
  final_holdout_untouched: finalHoldout.untouched,
  final_holdout_outcomes_accessed: false,
  FINAL_HOLDOUT_UNTOUCHED: finalHoldout.untouched,
  feasibility_matrix: feasibilityMatrix,
  flags: M14_SAFETY_FLAGS,
  decision,
  known_limitations: [
    'M1.1 and M1.2 lanes retain their frozen semantics and are diagnostic representatives; they are not new promotion candidates.',
    'All comparable lanes use one outcome-independent calendar with 48h purge, 24h embargo and the frozen final-holdout boundary.',
    'The event-alert comparator uses only same-timestamp valid configured symbols and evaluates future absolute movement after support is fixed; it does not claim trading profitability.',
    'Cost, horizon, density, tier, direction, regime and IC surfaces are diagnostic only and cannot create, retune or disable a signal lane.',
    'The review uses closed public Binance Futures 1h candles and the configured 18-symbol universe; it does not establish impossibility outside these tested public-data families.',
    'The final holdout is retained as boundary/hash/count metadata only; no holdout outcomes enter selection, metrics, event utility or the project decision.',
  ],
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
fs.mkdirSync(path.dirname(markdownPath), { recursive: true });
fs.writeFileSync(markdownPath, buildMarkdown(report));

console.log(JSON.stringify({
  experiment_id: report.experiment_id,
  review_version: report.review_version,
  experiment_source_sha: report.experiment_source_sha,
  source_sha_reachable: report.experiment_source_reachable,
  accepted_days: report.accepted_days,
  symbols: report.symbols.length,
  coverage_complete: report.coverage_complete,
  valid_cross_sectional_snapshots: report.valid_cross_sectional_snapshots,
  independent_market_events: report.independent_market_events,
  review_lanes: report.review_lanes.map(lane => lane.lane_id),
  canonical_review_plan_hash: report.canonical_review_plan_hash,
  canonical_review_windows: report.canonical_review_plan.windows.length,
  event_alert_utility: report.event_alert_utility.pass,
  event_alert_events: report.event_alert_utility.independent_events,
  frozen_lane_robust_gross_edge: report.FROZEN_LANE_ROBUST_GROSS_EDGE,
  density_robust_gross_edge: report.DENSITY_ROBUST_GROSS_EDGE,
  directional_research_signal: report.DIRECTIONAL_RESEARCH_SIGNAL,
  directional_gross_edge: report.directional_gross_edge,
  decision: report.decision,
  final_holdout_untouched: report.final_holdout_untouched,
  output: outputPath,
  markdown: markdownPath,
}, null, 2));

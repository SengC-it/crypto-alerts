// M1.4 feasibility diagnostics. This module is deliberately research-only:
// it consumes frozen signal records and closed-candle observations and never
// creates, retunes, or promotes a signal candidate.

import { hashConfig } from '../lineage.js';

const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;

export const M14_REVIEW_VERSION = 'm1.4-alpha-feasibility-0.1.1';
export const M14_HORIZONS_HOURS = Object.freeze([1, 4, 8, 12, 24, 48]);
export const M14_COSTS_PERCENT = Object.freeze([0, 0.05, 0.10, 0.14, 0.20, 0.30]);
export const M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS = 2000;
export const M14_EVENT_ALERT_BOOTSTRAP_SEED = 20260908;
export const M14_DENSITY_POLICIES = Object.freeze([
  'RAW_1H_SIGNAL_STREAM',
  'TOP1_PER_4H_EVENT_PER_DIRECTION',
  'TOP1_PER_4H_EVENT_TOTAL',
]);
export const M14_REQUIRED_PURGE_HOURS = 48;
export const M14_REQUIRED_EMBARGO_HOURS = 24;
export const M14_REQUIRED_LABEL_HORIZON_HOURS = 48;
export const M14_SAFETY_FLAGS = Object.freeze({
  SIGNAL_ONLY: true,
  USER_DECIDES_ENTRY: true,
  USER_DECIDES_POSITION_SIZE: true,
  USER_DECIDES_EXIT: true,
  V1_UNCHANGED: true,
  V2_PRODUCTION_ENABLED: false,
  AUTO_TRADING: false,
  PRIVATE_TRADING_API: false,
  M2_STARTED: false,
});

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function timestamp(value) {
  const numeric = finite(value);
  if (numeric !== null) return numeric;
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function average(values) {
  const valid = values.map(finite).filter(value => value !== null);
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function profitFactor(values) {
  const valid = values.map(finite).filter(value => value !== null);
  const wins = valid.filter(value => value > 0).reduce((sum, value) => sum + value, 0);
  const losses = Math.abs(valid.filter(value => value < 0).reduce((sum, value) => sum + value, 0));
  if (losses > 0) return wins / losses;
  return wins > 0 ? 999 : 0;
}

function eventId(record) {
  const explicit = record?.independent_market_event_id
    ?? record?.market_event_id
    ?? record?.event_id;
  if (explicit !== null && explicit !== undefined && explicit !== '') return String(explicit);
  const time = timestamp(record?.timestamp ?? record?.signal_timestamp);
  return time === null ? null : `m14-4h:${Math.floor(time / FOUR_HOURS) * FOUR_HOURS}`;
}

function recordTime(record) {
  return timestamp(record?.timestamp ?? record?.signal_timestamp ?? record?.close_time);
}

function grossOutcome(record, horizonHours) {
  const horizon = `${horizonHours}h`;
  return finite(record?.forward_returns?.[horizon])
    ?? finite(record?.gross_forward_returns?.[horizon])
    ?? (() => {
      const net = finite(record?.net_forward_returns?.[horizon]);
      return net === null ? null : net + 0.14;
    })();
}

function netOutcome(record, horizonHours, costPercent = 0.14) {
  const gross = grossOutcome(record, horizonHours);
  return gross === null ? null : gross - costPercent;
}

function resolvedHorizon(record, horizonHours) {
  if (horizonHours !== 'record_primary') return horizonHours;
  return Math.max(1, Math.floor(finite(record?.primary_horizon_hours) ?? 1));
}

function groupByEvent(records = []) {
  const groups = new Map();
  for (const record of records) {
    const id = eventId(record);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  return groups;
}

function windowForRecord(record, windows = []) {
  const time = recordTime(record);
  if (time === null) return null;
  return windows.find(window => {
    const start = finite(window.test_start_timestamp ?? window.test_start);
    const end = finite(window.test_end_timestamp ?? window.test_end);
    return start !== null && end !== null && time >= start && time <= end;
  })?.index ?? null;
}

function positiveWindowSummary(records, windows, valueAccessor) {
  const byWindow = new Map();
  for (const record of records) {
    const index = record.review_window_index ?? windowForRecord(record, windows);
    const value = valueAccessor(record);
    if (index === null || value === null) continue;
    if (!byWindow.has(index)) byWindow.set(index, []);
    byWindow.get(index).push(value);
  }
  const values = [...byWindow.entries()].map(([index, entries]) => ({
    window_index: index,
    expectancy: average(entries),
  }));
  return {
    total_windows: windows.length || values.length,
    positive_windows: values.filter(item => item.expectancy > 0).length,
    positive_window_ratio: values.length ? values.filter(item => item.expectancy > 0).length / values.length : 0,
    windows: values,
  };
}

function extractMfe(record, horizonHours) {
  const horizon = `${horizonHours}h`;
  return finite(record?.mfe_percent?.[horizon])
    ?? finite(record?.mfe?.[horizon])
    ?? finite(record?.max_favorable_excursion_percent?.[horizon])
    ?? finite(record?.mfe_percent);
}

function extractMae(record, horizonHours) {
  const horizon = `${horizonHours}h`;
  return finite(record?.mae_percent?.[horizon])
    ?? finite(record?.mae?.[horizon])
    ?? finite(record?.max_adverse_excursion_percent?.[horizon])
    ?? finite(record?.mae_percent);
}

/** Summarize a fixed signal stream without changing its selection policy. */
export function summarizeReviewRecords(records = [], {
  horizonHours = 8,
  costPercent = 0.14,
  windows = [],
} = {}) {
  const gross = records.map(record => grossOutcome(record, resolvedHorizon(record, horizonHours))).filter(value => value !== null);
  const net = records.map(record => netOutcome(record, resolvedHorizon(record, horizonHours), costPercent)).filter(value => value !== null);
  const eventGroups = groupByEvent(records);
  const grossPositiveWindows = positiveWindowSummary(records, windows, record => grossOutcome(record, resolvedHorizon(record, horizonHours)));
  const netPositiveWindows = positiveWindowSummary(records, windows, record => netOutcome(record, resolvedHorizon(record, horizonHours), costPercent));
  const symbols = new Set(records.map(record => record.symbol).filter(Boolean));
  const directions = new Set(records.map(record => record.direction).filter(Boolean));
  const wins = net.filter(value => value > 0).length;
  const eventSymbolIncidence = new Map();
  const recordCounts = new Map();
  for (const [id, eventRecords] of eventGroups) {
    const symbolsInEvent = new Set();
    for (const record of eventRecords) {
      const symbol = String(record.symbol || '').toUpperCase();
      if (!symbol) continue;
      symbolsInEvent.add(symbol);
      recordCounts.set(symbol, (recordCounts.get(symbol) || 0) + 1);
    }
    for (const symbol of symbolsInEvent) {
      if (!eventSymbolIncidence.has(symbol)) eventSymbolIncidence.set(symbol, new Set());
      eventSymbolIncidence.get(symbol).add(id);
    }
    void id;
  }
  const maxEventSymbolCount = Math.max(0, ...[...eventSymbolIncidence.values()].map(events => events.size));
  const maxRecordCount = Math.max(0, ...recordCounts.values());
  const uniqueEventSymbolConcentration = eventGroups.size ? maxEventSymbolCount / eventGroups.size : 0;
  const recordConcentration = records.length ? maxRecordCount / records.length : 0;
  return {
    signal_count: records.length,
    independent_events: eventGroups.size,
    symbol_breadth: symbols.size,
    direction_breadth: directions.size,
    gross_expectancy_percent: round(average(gross)),
    net_expectancy_percent: round(average(net)),
    gross_pf: round(profitFactor(gross), 6),
    net_pf: round(profitFactor(net), 6),
    hit_rate_percent: net.length ? round((wins / net.length) * 100, 6) : null,
    false_positive_rate_percent: net.length ? round(((net.length - wins) / net.length) * 100, 6) : null,
    avg_mfe_percent: round(average(records.map(record => extractMfe(record, resolvedHorizon(record, horizonHours))))) ,
    avg_mae_percent: round(average(records.map(record => extractMae(record, resolvedHorizon(record, horizonHours))))),
    gross_positive_windows: grossPositiveWindows.positive_windows,
    gross_positive_window_ratio: round(grossPositiveWindows.positive_window_ratio, 6),
    net_positive_windows: netPositiveWindows.positive_windows,
    net_positive_window_ratio: round(netPositiveWindows.positive_window_ratio, 6),
    positive_windows: netPositiveWindows.positive_windows,
    total_windows: netPositiveWindows.total_windows,
    positive_window_ratio: round(netPositiveWindows.positive_window_ratio, 6),
    gross_window_summaries: grossPositiveWindows.windows,
    net_window_summaries: netPositiveWindows.windows,
    window_summaries: netPositiveWindows.windows,
    max_symbol_event_concentration: round(uniqueEventSymbolConcentration, 8),
    unique_event_symbol_concentration: round(uniqueEventSymbolConcentration, 8),
    max_symbol_record_concentration: round(recordConcentration, 8),
    horizon_hours: horizonHours,
    cost_percent: costPercent,
  };
}

function rankValues(values) {
  const indexed = values.map((value, index) => ({ value: finite(value), index }))
    .filter(item => item.value !== null)
    .sort((left, right) => left.value - right.value || left.index - right.index);
  const ranks = new Array(values.length).fill(null);
  let index = 0;
  while (index < indexed.length) {
    let end = index + 1;
    while (end < indexed.length && indexed[end].value === indexed[index].value) end += 1;
    const rank = (index + end - 1) / 2 + 1;
    for (let cursor = index; cursor < end; cursor += 1) ranks[indexed[cursor].index] = rank;
    index = end;
  }
  return ranks;
}

function pearson(left, right) {
  const pairs = left.map((value, index) => [finite(value), finite(right[index])])
    .filter(pair => pair[0] !== null && pair[1] !== null);
  if (pairs.length < 2) return null;
  const leftMean = average(pairs.map(pair => pair[0]));
  const rightMean = average(pairs.map(pair => pair[1]));
  const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) * (pair[1] - rightMean), 0);
  const leftDenominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - leftMean) ** 2, 0));
  const rightDenominator = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[1] - rightMean) ** 2, 0));
  return leftDenominator && rightDenominator ? numerator / (leftDenominator * rightDenominator) : 0;
}

export function spearmanIc(records = [], { horizonHours = 8, windows = [] } = {}) {
  const perWindow = [];
  const groups = new Map();
  for (const record of records) {
    const index = record.review_window_index ?? windowForRecord(record, windows);
    if (index === null) continue;
    if (!groups.has(index)) groups.set(index, []);
    groups.get(index).push(record);
  }
  for (const [windowIndex, windowRecords] of groups) {
    const scores = windowRecords.map(record => finite(record.edge_score ?? record.raw_score));
    const outcomes = windowRecords.map(record => grossOutcome(record, horizonHours));
    const scoreRanks = rankValues(scores);
    const outcomeRanks = rankValues(outcomes);
    perWindow.push({
      window_index: windowIndex,
      sample_count: windowRecords.length,
      ic: round(pearson(scoreRanks, outcomeRanks), 8),
    });
  }
  const scores = records.map(record => finite(record.edge_score ?? record.raw_score));
  const outcomes = records.map(record => grossOutcome(record, horizonHours));
  const overall = pearson(rankValues(scores), rankValues(outcomes));
  const ics = perWindow.map(item => item.ic).filter(value => value !== null);
  return {
    horizon_hours: horizonHours,
    overall_ic: round(overall, 8),
    median_ic: round(ics.length ? [...ics].sort((a, b) => a - b)[Math.floor((ics.length - 1) / 2)] : null, 8),
    worst_ic: round(ics.length ? Math.min(...ics) : null, 8),
    positive_ic_windows: perWindow.filter(item => item.ic > 0).length,
    ic_dispersion: round(ics.length ? Math.sqrt(ics.reduce((sum, value) => sum + (value - average(ics)) ** 2, 0) / ics.length) : null, 8),
    per_window: perWindow,
  };
}

function seededRandom(seed) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

export function bootstrapEventValues(values = [], {
  repetitions = 2000,
  seed = M14_EVENT_ALERT_BOOTSTRAP_SEED,
} = {}) {
  const observations = values.map(finite).filter(value => value !== null);
  if (!observations.length) return { unit_count: 0, repetitions, seed, mean: null, ci95: [null, null], p_gt_zero: null };
  const random = seededRandom(seed);
  const means = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    let sum = 0;
    for (let index = 0; index < observations.length; index += 1) {
      sum += observations[Math.floor(random() * observations.length)];
    }
    means.push(sum / observations.length);
  }
  means.sort((left, right) => left - right);
  const percentile = fraction => means[Math.min(means.length - 1, Math.max(0, Math.floor((means.length - 1) * fraction)))];
  return {
    unit_count: observations.length,
    repetitions,
    seed,
    mean: round(average(observations), 8),
    ci95: [round(percentile(0.025), 8), round(percentile(0.975), 8)],
    p_gt_zero: round(means.filter(value => value > 0).length / means.length, 8),
  };
}

export function buildCostMatrix(records = [], {
  horizons = M14_HORIZONS_HOURS,
  costs = M14_COSTS_PERCENT,
  windows = [],
} = {}) {
  return horizons.map(horizonHours => ({
    horizon_hours: horizonHours,
    costs: costs.map(costPercent => {
      const summary = summarizeReviewRecords(records, { horizonHours, costPercent, windows });
      const gross = summary.gross_expectancy_percent;
      return {
        cost_percent: costPercent,
        ...summary,
        cost_drag_percent: gross === null || summary.net_expectancy_percent === null
          ? null
          : round(gross - summary.net_expectancy_percent, 8),
        gross_edge_consumed_percent: gross > 0 ? round((costPercent / gross) * 100, 8) : null,
        break_even_round_trip_cost: gross > 0 ? gross : 'NO_POSITIVE_GROSS_EDGE',
      };
    }),
  }));
}

function eventMeans(records, valueAccessor) {
  const groups = groupByEvent(records);
  return [...groups.entries()].map(([id, eventRecords]) => ({
    independent_market_event_id: id,
    value: average(eventRecords.map(valueAccessor)),
  })).filter(item => item.value !== null);
}

export function classifyDirectionalEdge(records = [], {
  horizonHours = 8,
  windows = [],
  calibration = 'UNKNOWN',
  costPercent = 0.14,
  repetitions = 2000,
  seed = M14_EVENT_ALERT_BOOTSTRAP_SEED,
} = {}) {
  const grossSummary = summarizeReviewRecords(records, { horizonHours, costPercent: 0, windows });
  const netSummary = summarizeReviewRecords(records, { horizonHours, costPercent, windows });
  const grossEventValues = eventMeans(records, record => grossOutcome(record, resolvedHorizon(record, horizonHours)));
  const netEventValues = eventMeans(records, record => netOutcome(record, resolvedHorizon(record, horizonHours), costPercent));
  const grossBootstrap = bootstrapEventValues(grossEventValues.map(item => item.value), { repetitions, seed });
  const netBootstrap = bootstrapEventValues(netEventValues.map(item => item.value), { repetitions, seed });
  const robustGross = grossSummary.gross_expectancy_percent > 0
    && grossSummary.gross_pf > 1
    && grossBootstrap.ci95[0] >= 0
    && grossBootstrap.p_gt_zero >= 0.95
    && grossSummary.gross_positive_window_ratio >= 2 / 3;
  const netPass = netSummary.independent_events >= 100
    && netSummary.net_pf >= 1.25
    && netSummary.net_expectancy_percent >= 0.15
    && netSummary.total_windows >= 6
    && netSummary.net_positive_windows >= 4
    && netSummary.net_positive_window_ratio >= 2 / 3
    && netSummary.symbol_breadth >= 8
    && calibration === 'PASS';
  return {
    classification: netPass
      ? 'NET_DIRECTIONAL_EDGE'
      : robustGross
        ? 'GROSS_EDGE_BUT_COST_CONSTRAINED'
        : 'NO_GROSS_DIRECTIONAL_EDGE',
    robust_gross_edge: robustGross,
    net_directional_edge: netPass,
    summary: netSummary,
    gross_summary: grossSummary,
    net_summary: netSummary,
    gross_bootstrap: grossBootstrap,
    net_bootstrap: netBootstrap,
  };
}

export function classifyDensityFeasibility(records = [], {
  horizonHours = 8,
  windows = [],
  repetitions = M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
  seed = M14_EVENT_ALERT_BOOTSTRAP_SEED,
} = {}) {
  const grossSummary = summarizeReviewRecords(records, { horizonHours, costPercent: 0, windows });
  const netSummary = summarizeReviewRecords(records, { horizonHours, costPercent: 0.14, windows });
  const grossEventValues = eventMeans(records, record => grossOutcome(record, resolvedHorizon(record, horizonHours)));
  const netEventValues = eventMeans(records, record => netOutcome(record, resolvedHorizon(record, horizonHours), 0.14));
  const grossBootstrap = bootstrapEventValues(grossEventValues.map(item => item.value), { repetitions, seed });
  const netBootstrap = bootstrapEventValues(netEventValues.map(item => item.value), { repetitions, seed });
  const failures = [];
  if (grossSummary.independent_events < 100) failures.push('independent_events');
  if (!(grossSummary.gross_expectancy_percent > 0)) failures.push('gross_expectancy');
  if (!(grossSummary.gross_pf > 1)) failures.push('gross_pf');
  if (!(grossBootstrap.ci95[0] >= 0)) failures.push('gross_bootstrap_ci95_lower');
  if (!(grossBootstrap.p_gt_zero >= 0.95)) failures.push('gross_bootstrap_p_gt_zero');
  if (!(grossSummary.gross_positive_window_ratio >= 2 / 3)) failures.push('gross_positive_window_ratio');
  if (grossSummary.symbol_breadth < 8) failures.push('symbol_breadth');
  if (grossSummary.unique_event_symbol_concentration > 0.30) failures.push('unique_event_symbol_concentration');
  const robustGross = failures.length === 0;
  return {
    horizon_hours: horizonHours,
    signal_count: grossSummary.signal_count,
    independent_events: grossSummary.independent_events,
    symbol_breadth: grossSummary.symbol_breadth,
    gross_expectancy_percent: grossSummary.gross_expectancy_percent,
    net_expectancy_percent: netSummary.net_expectancy_percent,
    gross_pf: grossSummary.gross_pf,
    net_pf: netSummary.net_pf,
    gross_positive_windows: grossSummary.gross_positive_windows,
    gross_positive_window_ratio: grossSummary.gross_positive_window_ratio,
    net_positive_windows: netSummary.net_positive_windows,
    net_positive_window_ratio: netSummary.net_positive_window_ratio,
    unique_event_symbol_concentration: grossSummary.unique_event_symbol_concentration,
    max_symbol_event_concentration: grossSummary.max_symbol_event_concentration,
    max_symbol_record_concentration: grossSummary.max_symbol_record_concentration,
    gross_bootstrap: grossBootstrap,
    net_bootstrap: netBootstrap,
    DENSITY_ROBUST_GROSS_EDGE: robustGross,
    density_robust_gross_edge: robustGross,
    gate_failures: failures,
  };
}

export function resolveFeasibilityDecision({
  frozenLaneRobustGrossEdge = false,
  densityRobustGrossEdge = false,
  eventAlertUtilityPass = false,
  evidenceSufficient = true,
} = {}) {
  if (!evidenceSufficient) return 'INSUFFICIENT_FEASIBILITY_EVIDENCE';
  if (frozenLaneRobustGrossEdge || densityRobustGrossEdge) return 'DIRECTIONAL_RESEARCH_CONTINUE';
  if (eventAlertUtilityPass) return 'PIVOT_TO_MARKET_EVENT_ALERTS';
  return 'STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM';
}

function closeKey(symbol, time) {
  return `${String(symbol).toUpperCase()}|${time}`;
}

function buildCloseLookup(candlesBySymbol = {}) {
  const lookup = new Map();
  for (const [symbol, candles] of Object.entries(candlesBySymbol)) {
    for (const candle of candles || []) {
      const closeTime = timestamp(candle.close_time ?? candle.timestamp);
      const close = finite(candle.close);
      if (closeTime !== null && close !== null && close > 0) lookup.set(closeKey(symbol, closeTime), close);
    }
  }
  return lookup;
}

function absoluteMove(closeLookup, symbol, start, horizonHours) {
  const entry = closeLookup.get(closeKey(symbol, start));
  const future = closeLookup.get(closeKey(symbol, start + horizonHours * HOUR));
  if (entry === undefined || future === undefined) return null;
  return Math.abs((future / entry - 1) * 100);
}

function realizedExcursion(closeLookup, symbol, start, horizonHours) {
  const entry = closeLookup.get(closeKey(symbol, start));
  if (entry === undefined) return null;
  const moves = [];
  for (let offset = 1; offset <= horizonHours; offset += 1) {
    const future = closeLookup.get(closeKey(symbol, start + offset * HOUR));
    if (future !== undefined) moves.push(Math.abs((future / entry - 1) * 100));
  }
  return moves.length ? Math.max(...moves) : null;
}

/**
 * Compare signal-symbol absolute movement with other symbols at the exact
 * same closed-candle timestamp. The comparator never reads future values to
 * choose a symbol; future values are used only after the timestamp is fixed.
 */
export function buildEventAlertObservations(records = [], {
  candlesBySymbol = {},
  snapshots = [],
  horizonHours = 8,
  windows = [],
} = {}) {
  const closeLookup = buildCloseLookup(candlesBySymbol);
  const snapshotByTime = new Map(snapshots.map(snapshot => [timestamp(snapshot.timestamp), snapshot]));
  const observations = [];
  for (const record of records) {
    const time = recordTime(record);
    const symbol = String(record.symbol || '').toUpperCase();
    const snapshot = snapshotByTime.get(time);
    if (time === null || !symbol || !snapshot) continue;
    const validSymbols = snapshot.valid_symbols || Object.keys(snapshot.candles || {});
    const alerted = absoluteMove(closeLookup, symbol, time, horizonHours);
    const alertedExcursion = realizedExcursion(closeLookup, symbol, time, horizonHours);
    const referenceMoves = validSymbols.filter(candidate => candidate !== symbol)
      .map(candidate => absoluteMove(closeLookup, candidate, time, horizonHours))
      .filter(value => value !== null);
    const referenceExcursions = validSymbols.filter(candidate => candidate !== symbol)
      .map(candidate => realizedExcursion(closeLookup, candidate, time, horizonHours))
      .filter(value => value !== null);
    if (alerted === null || !referenceMoves.length) continue;
    observations.push({
      timestamp: time,
      symbol,
      independent_market_event_id: eventId(record),
      review_window_index: record.review_window_index ?? windowForRecord(record, windows),
      alerted_abs_return: round(alerted, 8),
      matched_market_abs_return: round(average(referenceMoves), 8),
      delta_abs_return: round(alerted - average(referenceMoves), 8),
      alerted_realized_excursion: round(alertedExcursion, 8),
      matched_market_realized_excursion: round(average(referenceExcursions), 8),
      delta_realized_excursion: alertedExcursion === null || !referenceExcursions.length
        ? null
        : round(alertedExcursion - average(referenceExcursions), 8),
    });
  }
  const groups = groupByEvent(observations);
  return [...groups.entries()].map(([id, entries]) => ({
    independent_market_event_id: id,
    review_window_index: entries.find(entry => entry.review_window_index !== null)?.review_window_index ?? null,
    symbols: [...new Set(entries.map(entry => entry.symbol))].sort(),
    alerted_abs_return: average(entries.map(entry => entry.alerted_abs_return)),
    matched_market_abs_return: average(entries.map(entry => entry.matched_market_abs_return)),
    delta_abs_return: average(entries.map(entry => entry.delta_abs_return)),
    alerted_realized_excursion: average(entries.map(entry => entry.alerted_realized_excursion)),
    matched_market_realized_excursion: average(entries.map(entry => entry.matched_market_realized_excursion)),
    delta_realized_excursion: average(entries.map(entry => entry.delta_realized_excursion)),
  }));
}

export function summarizeEventAlertUtility(events = [], {
  windows = [],
  repetitions = M14_EVENT_ALERT_BOOTSTRAP_REPETITIONS,
  seed = M14_EVENT_ALERT_BOOTSTRAP_SEED,
} = {}) {
  const deltas = events.map(event => event.delta_abs_return).filter(value => finite(value) !== null);
  const bootstrap = bootstrapEventValues(deltas, { repetitions, seed });
  const byWindow = new Map();
  for (const event of events) {
    if (event.review_window_index === null || finite(event.delta_abs_return) === null) continue;
    if (!byWindow.has(event.review_window_index)) byWindow.set(event.review_window_index, []);
    byWindow.get(event.review_window_index).push(event.delta_abs_return);
  }
  const positiveWindows = [...byWindow.values()].filter(values => average(values) > 0).length;
  const breadth = new Set(events.flatMap(event => event.symbols || [])).size;
  const counts = {};
  for (const event of events) {
    for (const symbol of event.symbols || []) counts[symbol] = (counts[symbol] || 0) + 1;
  }
  const maxConcentration = events.length ? Math.max(0, ...Object.values(counts)) / events.length : 0;
  const positiveWindowRatio = byWindow.size ? positiveWindows / byWindow.size : 0;
  const gate = events.length >= 100
    && bootstrap.mean > 0
    && bootstrap.ci95[0] >= 0
    && bootstrap.p_gt_zero >= 0.95
    && byWindow.size >= 6
    && positiveWindowRatio >= 2 / 3
    && breadth >= 8
    && maxConcentration <= 0.30;
  return {
    event_count: events.length,
    delta_8h_absolute_return: round(bootstrap.mean, 8),
    delta_8h_ci95: bootstrap.ci95,
    p_delta_gt_zero: bootstrap.p_gt_zero,
    positive_windows: positiveWindows,
    oos_windows: byWindow.size || windows.length,
    positive_window_ratio: round(positiveWindowRatio, 8),
    symbol_breadth: breadth,
    max_symbol_event_concentration: round(maxConcentration, 8),
    bootstrap: {
      unit: 'independent_market_event_id',
      repetitions,
      seed,
      event_count: events.length,
    },
    gate_pass: gate,
    gate_failures: [
      events.length < 100 ? 'independent_events' : null,
      !(bootstrap.mean > 0) ? 'delta_not_positive' : null,
      !(bootstrap.ci95[0] >= 0) ? 'ci_lower_bound' : null,
      !(bootstrap.p_gt_zero >= 0.95) ? 'probability' : null,
      byWindow.size < 6 ? 'oos_windows' : null,
      !(positiveWindowRatio >= 2 / 3) ? 'positive_window_ratio' : null,
      breadth < 8 ? 'symbol_breadth' : null,
      !(maxConcentration <= 0.30) ? 'concentration' : null,
    ].filter(Boolean),
  };
}

function sortByScore(records) {
  return [...records].sort((left, right) => (
    (finite(right.edge_score ?? right.raw_score) ?? -Infinity) - (finite(left.edge_score ?? left.raw_score) ?? -Infinity)
    || String(left.symbol || '').localeCompare(String(right.symbol || ''))
    || (recordTime(left) ?? 0) - (recordTime(right) ?? 0)
  ));
}

export function buildDensityViews(records = []) {
  const byEventDirection = new Map();
  const byEvent = new Map();
  for (const record of records) {
    const id = eventId(record);
    if (!id) continue;
    const direction = String(record.direction || 'UNKNOWN').toUpperCase();
    const directionKey = `${id}|${direction}`;
    if (!byEventDirection.has(directionKey)) byEventDirection.set(directionKey, []);
    if (!byEvent.has(id)) byEvent.set(id, []);
    byEventDirection.get(directionKey).push(record);
    byEvent.get(id).push(record);
  }
  return {
    RAW_1H_SIGNAL_STREAM: [...records],
    TOP1_PER_4H_EVENT_PER_DIRECTION: [...byEventDirection.values()].map(group => sortByScore(group)[0]).filter(Boolean),
    TOP1_PER_4H_EVENT_TOTAL: [...byEvent.values()].map(group => sortByScore(group)[0]).filter(Boolean),
  };
}

export function buildUniverseSlices(records = [], tiers = {}) {
  const tierSets = Object.fromEntries(Object.entries(tiers).map(([key, symbols]) => [
    key,
    new Set((symbols || []).map(symbol => String(symbol).toUpperCase())),
  ]));
  const all = new Set(Object.values(tierSets).flatMap(set => [...set]));
  const tier12 = new Set([...(tierSets.tier1 || []), ...(tierSets.tier2 || [])]);
  const slices = {
    Tier1: tierSets.tier1 || new Set(),
    Tier2: tierSets.tier2 || new Set(),
    Tier3: tierSets.tier3 || new Set(),
    'Tier1+Tier2': tier12,
    All18: all,
  };
  return Object.fromEntries(Object.entries(slices).map(([name, symbols]) => [
    name,
    records.filter(record => symbols.has(String(record.symbol || '').toUpperCase())),
  ]));
}

export function buildDirectionSlices(records = []) {
  return {
    BUY: records.filter(record => String(record.direction || '').toUpperCase() === 'BUY'),
    SELL: records.filter(record => String(record.direction || '').toUpperCase() === 'SELL'),
  };
}

export function buildRegimeSlices(records = []) {
  const result = { Bull: [], Bear: [], Sideways: [], Low: [], Normal: [], High: [], Extreme: [] };
  for (const record of records) {
    const trend = record.trend_regime ?? record.trend ?? record.market_regime;
    const volatility = record.volatility_regime ?? record.volatility;
    if (result[trend]) result[trend].push(record);
    if (result[volatility]) result[volatility].push(record);
  }
  return result;
}

export function buildLossAttribution(summary = {}, {
  buySummary = null,
  sellSummary = null,
  calibration = 'UNKNOWN',
} = {}) {
  const gross = finite(summary.gross_expectancy_percent);
  const net = finite(summary.net_expectancy_percent);
  const costDrag = gross !== null && net !== null ? Math.max(0, gross - net) : 0;
  const directionGap = buySummary && sellSummary
    ? Math.abs((buySummary.net_expectancy_percent || 0) - (sellSummary.net_expectancy_percent || 0))
    : 0;
  const result = {
    gross_winning_contribution_percent: null,
    gross_losing_contribution_percent: null,
    transaction_cost_drag_percent: round(costDrag, 8),
    false_positive_rate_percent: summary.false_positive_rate_percent ?? null,
    average_winning_move_percent: null,
    average_losing_move_percent: null,
    signal_frequency: summary.signal_count ?? 0,
    cluster_concentration: summary.max_symbol_event_concentration ?? null,
    LOSS_FROM_NO_DIRECTIONAL_EDGE: gross === null || gross <= 0 ? 1 : 0,
    LOSS_FROM_COST: gross !== null && gross > 0 && net !== null && net < 0 ? round(Math.min(1, costDrag / gross), 8) : 0,
    LOSS_FROM_CLUSTERING: summary.max_symbol_event_concentration > 0.30 ? 1 : 0,
    LOSS_FROM_CALIBRATION: calibration === 'PASS' ? 0 : 1,
    LOSS_FROM_DIRECTION_IMBALANCE: directionGap > 0.10 ? 1 : 0,
    attribution_note: 'Categories overlap and are diagnostic; they are not forced to sum to 100%.',
  };
  return result;
}

export function buildCanonicalReviewPlan({
  windows = [],
  sourceTimelineStart = null,
  sourceTimelineEnd = null,
  finalHoldoutStart = null,
  purgeHours = M14_REQUIRED_PURGE_HOURS,
  embargoHours = M14_REQUIRED_EMBARGO_HOURS,
  labelHorizonHours = M14_REQUIRED_LABEL_HORIZON_HOURS,
} = {}) {
  const normalizedWindows = windows.map(window => ({
    index: window.index,
    train_start_timestamp: window.train_start_timestamp ?? window.train_start ?? null,
    train_end_timestamp: window.train_end_timestamp ?? window.train_end ?? null,
    purge_start_timestamp: window.purge_start_timestamp ?? window.purge_start ?? null,
    purge_end_timestamp: window.purge_end_timestamp ?? window.purge_end ?? null,
    test_start_timestamp: window.test_start_timestamp ?? window.test_start ?? null,
    test_end_timestamp: window.test_end_timestamp ?? window.test_end ?? null,
    embargo_start_timestamp: window.embargo_start_timestamp ?? window.embargo_start ?? null,
    embargo_end_timestamp: window.embargo_end_timestamp ?? window.embargo_end ?? null,
    final_holdout_start_timestamp: window.final_holdout_start_timestamp ?? window.final_holdout_start ?? finalHoldoutStart,
  }));
  const plan = {
    version: M14_REVIEW_VERSION,
    source_timeline_start: sourceTimelineStart,
    source_timeline_end: sourceTimelineEnd,
    purge_hours: purgeHours,
    embargo_hours: embargoHours,
    label_horizon_hours: labelHorizonHours,
    final_holdout_start: finalHoldoutStart,
    windows: normalizedWindows,
  };
  return { ...plan, canonical_review_plan_hash: hashConfig(plan) };
}

export function assertReviewCalendarParity(lanes = []) {
  if (!lanes.length) throw new Error('M1.4 requires at least one review lane');
  const first = lanes[0].review_plan;
  const firstHash = first?.canonical_review_plan_hash;
  const firstWindows = JSON.stringify(first?.windows || []);
  for (const lane of lanes) {
    const windows = JSON.stringify(lane.review_plan?.windows || []);
    if (lane.review_plan?.canonical_review_plan_hash !== firstHash || windows !== firstWindows) {
      throw new Error(`M1.4 review calendar parity failed for ${lane.lane_id}`);
    }
  }
  return {
    canonical_review_plan_hash: firstHash,
    same_train_windows: true,
    same_oos_windows: true,
    same_purge: lanes.every(lane => lane.review_plan?.purge_hours === M14_REQUIRED_PURGE_HOURS),
    same_embargo: lanes.every(lane => lane.review_plan?.embargo_hours === M14_REQUIRED_EMBARGO_HOURS),
    same_final_holdout_boundary: lanes.every(lane => lane.review_plan?.final_holdout_start === first.final_holdout_start),
  };
}

export function reviewConfigHash({
  baseMainSha,
  reviewVersion = M14_REVIEW_VERSION,
  symbols = [],
  lanes = [],
  calendarHash,
  costs = M14_COSTS_PERCENT,
  horizons = M14_HORIZONS_HOURS,
} = {}) {
  return hashConfig({
    base_main_sha: baseMainSha,
    review_version: reviewVersion,
    symbols: [...symbols].sort(),
    lane_ids: lanes.map(lane => lane.lane_id).sort(),
    canonical_review_plan_hash: calendarHash,
    costs,
    horizons,
    selection_is_frozen: true,
    final_holdout_outcomes_accessed: false,
  });
}

export function compactEventAlertEvents(events = []) {
  return {
    count: events.length,
    ids_hash: hashConfig(events.map(event => event.independent_market_event_id).sort()),
    values_hash: hashConfig(events.map(event => ({
      id: event.independent_market_event_id,
      delta_abs_return: round(event.delta_abs_return, 8),
    }))),
  };
}

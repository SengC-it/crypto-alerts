// M1.5 causal signal sparsification review.
//
// This module owns the frozen, outcome-independent selection and validation
// contract. It is research-only: it never changes a production route, score,
// candidate definition, or trading permission.

import { hashConfig } from '../lineage.js';
import {
  buildDensityViews,
  summarizeReviewRecords,
} from './m14Review.js';

const HOUR = 60 * 60 * 1000;
const FOUR_HOURS = 4 * HOUR;

export const M15_RESEARCH_VERSION = 'm1.5-causal-sparsification-0.1.1';
export const M15_BASE_MAIN_SHA = '748e41815948ca5cd7b9016738a593b760e5d6ad';
export const M15_M14_SOURCE_SHA = '859ea3ba69bf7df89cb6f2fe34ebd9fd0dd1ac8d';
export const M15_X8_CANDIDATE = 'X8-btc-eth-lead-lag-continuation';
export const M15_PRIMARY_HORIZON_HOURS = 8;
export const M15_COST_PERCENT = 0.14;
export const M15_BOOTSTRAP_REPETITIONS = 5000;
export const M15_BOOTSTRAP_SEED = 20260909;
export const M15_MOVING_BLOCK_LENGTH = 3;
export const M15_VALIDATION_WINDOW_COUNT = 8;
export const M15_MIN_BUCKET_CLOSE_BREADTH = 12;
export const M15_VALIDATION_SIGNAL_START = '2026-07-12T12:59:59.999Z';
export const M15_VALIDATION_SIGNAL_END = '2026-09-07T15:59:59.999Z';
export const M15_OUTCOME_DATA_END = '2026-09-07T23:59:59.999Z';
export const M15_EXPERIMENT_ID = 'm1.5-public_binance_futures-2026-07-12_to_2026-09-07-causal-sparsification-0.1.1';

export const M15_POLICY_IDS = Object.freeze({
  D1: 'RETROSPECTIVE_TOP1_PER_4H_EVENT_PER_DIRECTION',
  D2: 'RETROSPECTIVE_TOP1_PER_4H_EVENT_TOTAL',
  C1: 'CAUSAL_BUCKET_CLOSE_TOP1_PER_DIRECTION',
  C2: 'CAUSAL_BUCKET_CLOSE_TOP1_TOTAL',
});

export const M15_POLICY_ORDER = Object.freeze([
  M15_POLICY_IDS.D1,
  M15_POLICY_IDS.D2,
  M15_POLICY_IDS.C1,
  M15_POLICY_IDS.C2,
]);

export const M15_SAFETY_FLAGS = Object.freeze({
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

export const M15_DISCOVERY_REFERENCE = Object.freeze({
  gross_expectancy_percent: 0.38239275,
  net_expectancy_percent: 0.24239275,
  gross_pf: 1.473203,
  net_pf: 1.27784,
  gross_positive_windows: 8,
  net_positive_windows: 8,
  unique_event_symbol_concentration: 0.28586279,
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

function iso(value) {
  const time = timestamp(value);
  return time === null ? null : new Date(time).toISOString();
}

function round(value, digits = 8) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? null
    : +Number(value).toFixed(digits);
}

function eventId(record) {
  const explicit = record?.independent_market_event_id
    ?? record?.market_event_id
    ?? record?.event_id;
  if (explicit !== null && explicit !== undefined && explicit !== '') return String(explicit);
  return null;
}

function recordTime(record) {
  return timestamp(record?.timestamp ?? record?.signal_timestamp ?? record?.close_time);
}

function direction(record) {
  return String(record?.direction || '').toUpperCase();
}

function symbol(record) {
  return String(record?.symbol || '').toUpperCase();
}

function grossOutcome(record) {
  return finite(record?.forward_returns?.['8h'])
    ?? finite(record?.gross_forward_returns?.['8h'])
    ?? (() => {
      const net = finite(record?.net_forward_returns?.['8h']);
      return net === null ? null : net + M15_COST_PERCENT;
    })();
}

function netOutcome(record) {
  const gross = grossOutcome(record);
  return gross === null ? null : gross - M15_COST_PERCENT;
}

function selectionKey(record) {
  return String(eventId(record)) + '|' + symbol(record) + '|' + direction(record);
}

function eventGroups(records = []) {
  const groups = new Map();
  for (const record of records) {
    const id = eventId(record);
    if (!id) continue;
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(record);
  }
  return groups;
}

export function fixedEventBoundsFromId(value) {
  const event_id = String(value ?? '');
  const match = event_id.match(/^(?:m13|m15)-4h:(\d+)$/);
  if (!match) return null;
  const event_start_timestamp = Number(match[1]);
  const event_close_timestamp = event_start_timestamp + FOUR_HOURS - 1;
  if (!Number.isSafeInteger(event_start_timestamp)
    || !Number.isSafeInteger(event_close_timestamp)
    || event_start_timestamp % FOUR_HOURS !== 0) {
    return null;
  }
  return {
    event_id,
    event_start_timestamp,
    event_close_timestamp,
  };
}

function invalidFixedEventError(value) {
  const error = new Error('INVALID_FIXED_MARKET_EVENT_ID: ' + String(value ?? ''));
  error.code = 'INVALID_FIXED_MARKET_EVENT_ID';
  return error;
}

function assertFixedEventId(value) {
  const bounds = fixedEventBoundsFromId(value);
  if (!bounds) throw invalidFixedEventError(value);
  return bounds;
}

function eventSummaries(records = []) {
  for (const record of records) assertFixedEventId(eventId(record));
  return [...eventGroups(records)].map(([id, rows]) => {
    const bounds = assertFixedEventId(id);
    return {
      event_id: id,
      event_close_timestamp: bounds.event_close_timestamp,
      event_start_timestamp: bounds.event_start_timestamp,
      record_count: rows.length,
    };
  });
}

function compareEvents(left, right) {
  return left.event_close_timestamp - right.event_close_timestamp
    || left.event_id.localeCompare(right.event_id);
}

function withWindow(record, index) {
  return { ...record, review_window_index: index };
}

/**
 * D1 and D2 are an exact reuse of M1.4 buildDensityViews. They are retained
 * as retrospective diagnostics and are explicitly non-deployable.
 */
export function buildRetrospectiveViews(records = []) {
  for (const record of records) assertFixedEventId(eventId(record));
  const views = buildDensityViews(records);
  return {
    [M15_POLICY_IDS.D1]: [...views.TOP1_PER_4H_EVENT_PER_DIRECTION],
    [M15_POLICY_IDS.D2]: [...views.TOP1_PER_4H_EVENT_TOTAL],
    support: {
      source: 'M1.4 buildDensityViews',
      deployable: false,
      policy_count: 2,
    },
  };
}

function closeRowsForEvent(id, rows) {
  const closeTimestamp = assertFixedEventId(id).event_close_timestamp;
  return {
    closeTimestamp,
    rows: rows
      .filter(record => recordTime(record) === closeTimestamp)
      .map(record => ({
        ...record,
        causal_bucket_close: true,
        bucket_close_signal_timestamp: closeTimestamp,
      })),
  };
}

/**
 * C1/C2 are selected only from the last fully closed 1h snapshot in each
 * fixed 4h event. Outcome fields are never consulted here.
 */
export function buildCausalViews(records = [], {
  minValidSymbols = M15_MIN_BUCKET_CLOSE_BREADTH,
} = {}) {
  for (const record of records) assertFixedEventId(eventId(record));
  const eligibleCloseRows = [];
  const eligibleEvents = [];
  const rejectedEvents = [];

  for (const [id, rows] of eventGroups(records)) {
    const { closeTimestamp, rows: closeRows } = closeRowsForEvent(id, rows);
    const symbols = new Set(closeRows.map(symbol).filter(Boolean));
    const breadth = symbols.size;
    if (closeTimestamp === null || breadth < minValidSymbols) {
      rejectedEvents.push({
        event_id: id,
        event_close_timestamp: closeTimestamp,
        reason: 'INSUFFICIENT_BUCKET_CLOSE_BREADTH',
        valid_symbol_count: breadth,
      });
      continue;
    }
    eligibleEvents.push({
      event_id: id,
      event_close_timestamp: closeTimestamp,
      event_start_timestamp: closeTimestamp - FOUR_HOURS + 1,
      valid_symbol_count: breadth,
    });
    eligibleCloseRows.push(...closeRows);
  }

  const views = buildDensityViews(eligibleCloseRows);
  return {
    [M15_POLICY_IDS.C1]: [...views.TOP1_PER_4H_EVENT_PER_DIRECTION],
    [M15_POLICY_IDS.C2]: [...views.TOP1_PER_4H_EVENT_TOTAL],
    support: {
      source: 'last fully closed 1h snapshot at fixed 4h bucket close',
      min_valid_symbols: minValidSymbols,
      eligible_events: eligibleEvents,
      rejected_events: rejectedEvents,
      close_records: eligibleCloseRows,
      deployable: false,
      policy_count: 2,
    },
  };
}

/**
 * Split ordered eligible event IDs into exactly eight contiguous windows.
 * Only event chronology and fixed IDs enter the plan hash.
 */
export function buildValidationWindows(records = [], {
  windowCount = M15_VALIDATION_WINDOW_COUNT,
} = {}) {
  if (!Number.isInteger(windowCount) || windowCount < 1) {
    throw new Error('M1.5 validation window count must be a positive integer');
  }
  const events = eventSummaries(records).sort(compareEvents);
  if (events.length < windowCount) {
    throw new Error('M1.5 requires at least ' + windowCount + ' eligible events; received ' + events.length);
  }
  const baseSize = Math.floor(events.length / windowCount);
  const remainder = events.length % windowCount;
  const windows = [];
  const eventWindowMap = [];
  let cursor = 0;
  for (let index = 0; index < windowCount; index += 1) {
    const count = baseSize + (index < remainder ? 1 : 0);
    const slice = events.slice(cursor, cursor + count);
    cursor += count;
    const first = slice[0];
    const last = slice.at(-1);
    windows.push({
      index,
      event_count: slice.length,
      event_id_start: first.event_id,
      event_id_end: last.event_id,
      event_start_timestamp: first.event_start_timestamp,
      event_close_start_timestamp: first.event_close_timestamp,
      event_close_end_timestamp: last.event_close_timestamp,
      signal_start_timestamp: first.event_close_timestamp,
      signal_end_timestamp: last.event_close_timestamp,
    });
    for (const event of slice) {
      eventWindowMap.push({
        event_id: event.event_id,
        event_start_timestamp: event.event_start_timestamp,
        event_close_timestamp: event.event_close_timestamp,
        window_index: index,
      });
    }
  }
  const plan = {
    version: M15_RESEARCH_VERSION,
    window_count: windowCount,
    eligible_event_count: events.length,
    windows,
    event_window_map: eventWindowMap,
  };
  return {
    ...plan,
    validation_plan_hash: hashConfig(plan),
    validation_event_window_map_hash: hashConfig(eventWindowMap),
  };
}

function eventWindowMapForPlan(records, plan = {}) {
  if (Array.isArray(plan.event_window_map) && plan.event_window_map.length) {
    return plan.event_window_map.map(item => ({
      event_id: String(item.event_id),
      event_start_timestamp: finite(item.event_start_timestamp),
      event_close_timestamp: finite(item.event_close_timestamp),
      window_index: item.window_index,
    }));
  }
  const ranges = (plan.windows || []).map(window => ({
    ...window,
    start: finite(window.event_close_start_timestamp),
    end: finite(window.event_close_end_timestamp),
  }));
  return eventSummaries(records).sort(compareEvents).map(event => {
    const window = ranges.find(candidate => (
      event.event_close_timestamp >= candidate.start
      && event.event_close_timestamp <= candidate.end
    ));
    return window ? {
      event_id: event.event_id,
      event_start_timestamp: event.event_start_timestamp,
      event_close_timestamp: event.event_close_timestamp,
      window_index: window.index,
    } : null;
  }).filter(Boolean);
}

function hashEventIds(ids = []) {
  return hashConfig([...new Set([...ids].map(String))].sort());
}

export function assignPolicyRecordsToValidationWindows(records = [], plan = {}) {
  const eventWindowMap = eventWindowMapForPlan(records, plan);
  const byEvent = new Map(eventWindowMap.map(item => [item.event_id, item.window_index]));
  const planEventIds = new Set(byEvent.keys());
  const assigned = [];
  const dropped = [];
  const inputEventIds = new Set();
  const assignedEventIds = new Set();
  const droppedEventIds = new Set();
  const droppedInSupportEventIds = new Set();

  for (const record of records) {
    const id = eventId(record);
    assertFixedEventId(id);
    inputEventIds.add(id);
    const index = byEvent.get(id);
    if (index === undefined) {
      dropped.push(record);
      droppedEventIds.add(id);
      continue;
    }
    assigned.push(withWindow(record, index));
    assignedEventIds.add(id);
  }

  for (const id of inputEventIds) {
    if (planEventIds.has(id) && !assignedEventIds.has(id)) droppedInSupportEventIds.add(id);
  }
  const validationEventWindowMapHash = plan.validation_event_window_map_hash
    || hashConfig(eventWindowMap);
  const inputInSupportEventIds = [...inputEventIds].filter(id => planEventIds.has(id));
  const droppedInSupportRecords = dropped.filter(record => planEventIds.has(eventId(record))).length;
  const assignmentIntegrity = {
    pass: droppedInSupportRecords === 0
      && droppedInSupportEventIds.size === 0
      && assigned.every(record => byEvent.get(eventId(record)) === record.review_window_index),
    all_records_from_same_event_share_window: assigned.every(record => (
      byEvent.get(eventId(record)) === record.review_window_index
    )),
    input_event_ids_in_validation_plan: inputInSupportEventIds.length,
    dropped_in_support_event_count: droppedInSupportEventIds.size,
    dropped_in_support_record_count: droppedInSupportRecords,
    validation_event_window_map_hash: validationEventWindowMapHash,
  };
  return {
    records: assigned,
    input_signal_count: records.length,
    assigned_signal_count: assigned.length,
    dropped_signal_count: dropped.length,
    input_independent_events: inputEventIds.size,
    assigned_independent_events: assignedEventIds.size,
    dropped_independent_events: droppedEventIds.size,
    dropped_in_support_policy_records: droppedInSupportRecords,
    dropped_in_support_event_ids: [...droppedInSupportEventIds].sort(),
    input_event_ids_hash: hashEventIds(inputEventIds),
    assigned_event_ids_hash: hashEventIds(assignedEventIds),
    dropped_event_ids_hash: hashEventIds(droppedEventIds),
    event_assignment_integrity: assignmentIntegrity,
    validation_event_window_map_hash: validationEventWindowMapHash,
  };
}

export function assignValidationWindows(records = [], plan = {}) {
  return assignPolicyRecordsToValidationWindows(records, plan).records;
}

function eventValueSeries(records = [], accessor) {
  const result = [];
  for (const [id, rows] of eventGroups(records)) {
    const values = rows.map(accessor).filter(value => value !== null);
    if (!values.length) continue;
    result.push({
      event_id: id,
      event_close_timestamp: assertFixedEventId(id).event_close_timestamp,
      value: values.reduce((sum, value) => sum + value, 0) / values.length,
    });
  }
  return result.sort((left, right) => (
    left.event_close_timestamp - right.event_close_timestamp
    || left.event_id.localeCompare(right.event_id)
  ));
}

function percentile(sorted, fraction) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * fraction)))];
}

function seededRandom(seed) {
  let state = Math.abs(Math.trunc(Number(seed))) || 1;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function bootstrapSeries(values, {
  repetitions = M15_BOOTSTRAP_REPETITIONS,
  seed = M15_BOOTSTRAP_SEED,
} = {}) {
  const observations = values.map(finite).filter(value => value !== null);
  if (!observations.length) {
    return {
      unit: 'independent_market_event_id',
      unit_count: 0,
      repetitions,
      seed,
      mean: null,
      ci95: [null, null],
      p_gt_zero: null,
    };
  }
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
  return {
    unit: 'independent_market_event_id',
    unit_count: observations.length,
    repetitions,
    seed,
    mean: round(observations.reduce((sum, value) => sum + value, 0) / observations.length),
    ci95: [round(percentile(means, 0.025)), round(percentile(means, 0.975))],
    p_gt_zero: round(means.filter(value => value > 0).length / means.length),
  };
}

function movingBlockSeries(values, {
  blockLength = M15_MOVING_BLOCK_LENGTH,
  repetitions = M15_BOOTSTRAP_REPETITIONS,
  seed = M15_BOOTSTRAP_SEED,
} = {}) {
  const observations = values.map(finite).filter(value => value !== null);
  if (!observations.length) {
    return {
      unit: 'ordered_independent_market_event_id',
      block_length_events: blockLength,
      block_length_hours: blockLength * 4,
      unit_count: 0,
      repetitions,
      seed,
      mean: null,
      ci95: [null, null],
      p_gt_zero: null,
    };
  }
  if (observations.length < blockLength) {
    return {
      unit: 'ordered_independent_market_event_id',
      block_length_events: blockLength,
      block_length_hours: blockLength * 4,
      unit_count: observations.length,
      repetitions,
      seed,
      mean: round(observations.reduce((sum, value) => sum + value, 0) / observations.length),
      ci95: [null, null],
      p_gt_zero: null,
      insufficient_blocks: true,
    };
  }
  const random = seededRandom(seed);
  const maxStart = observations.length - blockLength;
  const means = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const sample = [];
    while (sample.length < observations.length) {
      const start = Math.floor(random() * (maxStart + 1));
      sample.push(...observations.slice(start, start + blockLength));
    }
    const truncated = sample.slice(0, observations.length);
    means.push(truncated.reduce((sum, value) => sum + value, 0) / truncated.length);
  }
  means.sort((left, right) => left - right);
  return {
    unit: 'ordered_independent_market_event_id',
    block_length_events: blockLength,
    block_length_hours: blockLength * 4,
    unit_count: observations.length,
    repetitions,
    seed,
    mean: round(observations.reduce((sum, value) => sum + value, 0) / observations.length),
    ci95: [round(percentile(means, 0.025)), round(percentile(means, 0.975))],
    p_gt_zero: round(means.filter(value => value > 0).length / means.length),
  };
}

export function standardEventBootstrap(records = [], {
  repetitions = M15_BOOTSTRAP_REPETITIONS,
  seed = M15_BOOTSTRAP_SEED,
} = {}) {
  const gross = eventValueSeries(records, grossOutcome).map(item => item.value);
  const net = eventValueSeries(records, netOutcome).map(item => item.value);
  return {
    gross: bootstrapSeries(gross, { repetitions, seed }),
    net: bootstrapSeries(net, { repetitions, seed }),
  };
}

export function movingBlockBootstrap(records = [], {
  repetitions = M15_BOOTSTRAP_REPETITIONS,
  seed = M15_BOOTSTRAP_SEED,
  blockLength = M15_MOVING_BLOCK_LENGTH,
} = {}) {
  const gross = eventValueSeries(records, grossOutcome).map(item => item.value);
  const net = eventValueSeries(records, netOutcome).map(item => item.value);
  return {
    gross: movingBlockSeries(gross, { repetitions, seed, blockLength }),
    net: movingBlockSeries(net, { repetitions, seed, blockLength }),
  };
}

export function evaluateM15Policy(records = [], planOrWindows = [], {
  repetitions = M15_BOOTSTRAP_REPETITIONS,
  seed = M15_BOOTSTRAP_SEED,
} = {}) {
  const plan = Array.isArray(planOrWindows) ? { windows: planOrWindows } : planOrWindows;
  const windows = plan.windows || [];
  const assignment = assignPolicyRecordsToValidationWindows(records, plan);
  const assigned = assignment.records;
  const summary = summarizeReviewRecords(assigned, {
    horizonHours: M15_PRIMARY_HORIZON_HOURS,
    costPercent: M15_COST_PERCENT,
    windows,
  });
  const grossSummary = summarizeReviewRecords(assigned, {
    horizonHours: M15_PRIMARY_HORIZON_HOURS,
    costPercent: 0,
    windows,
  });
  return {
    ...summary,
    gross_expectancy_percent: grossSummary.gross_expectancy_percent,
    gross_pf: grossSummary.gross_pf,
    gross_positive_windows: grossSummary.gross_positive_windows,
    gross_positive_window_ratio: grossSummary.gross_positive_window_ratio,
    gross_window_summaries: grossSummary.gross_window_summaries,
    standard_bootstrap: standardEventBootstrap(assigned, { repetitions, seed }),
    moving_block_bootstrap: movingBlockBootstrap(assigned, { repetitions, seed }),
    assignment,
    assigned_records: assigned,
  };
}

function gateResult(failures) {
  return {
    pass: failures.length === 0,
    failures,
  };
}

export function evaluateD1Replication(policy = {}) {
  const failures = [];
  if ((policy.independent_events ?? 0) < 100) failures.push('independent_events');
  if (!(policy.gross_expectancy_percent > 0)) failures.push('gross_expectancy_percent');
  if (!(policy.gross_pf > 1)) failures.push('gross_pf');
  if (!((policy.standard_bootstrap?.gross?.ci95?.[0] ?? -Infinity) >= 0)) failures.push('standard_gross_ci95_lower');
  if (!((policy.standard_bootstrap?.gross?.p_gt_zero ?? 0) >= 0.95)) failures.push('standard_gross_p_gt_zero');
  if (!(policy.gross_positive_window_ratio >= 2 / 3)) failures.push('gross_positive_window_ratio');
  if ((policy.symbol_breadth ?? 0) < 8) failures.push('symbol_breadth');
  if ((policy.unique_event_symbol_concentration ?? Infinity) > 0.30) failures.push('unique_event_symbol_concentration');
  return gateResult(failures);
}

export function evaluateC1Confirmation(policy = {}) {
  const failures = [];
  if ((policy.independent_events ?? 0) < 100) failures.push('independent_events');
  if (!(policy.net_expectancy_percent > 0)) failures.push('net_expectancy_percent');
  if (!(policy.net_pf > 1)) failures.push('net_pf');
  if (!((policy.standard_bootstrap?.net?.ci95?.[0] ?? -Infinity) >= 0)) failures.push('standard_net_ci95_lower');
  if (!((policy.standard_bootstrap?.net?.p_gt_zero ?? 0) >= 0.95)) failures.push('standard_net_p_gt_zero');
  if (!((policy.moving_block_bootstrap?.net?.ci95?.[0] ?? -Infinity) >= 0)) failures.push('moving_block_net_ci95_lower');
  if (!((policy.moving_block_bootstrap?.net?.p_gt_zero ?? 0) >= 0.95)) failures.push('moving_block_net_p_gt_zero');
  if (!(policy.net_positive_window_ratio >= 2 / 3)) failures.push('net_positive_window_ratio');
  if ((policy.symbol_breadth ?? 0) < 8) failures.push('symbol_breadth');
  if ((policy.unique_event_symbol_concentration ?? Infinity) > 0.30) failures.push('unique_event_symbol_concentration');
  return gateResult(failures);
}

export function evaluateAbsolutePromotion(policy = {}, calibration = {}) {
  const failures = [];
  if (!policy.confirmation_pass) failures.push('c1_confirmation_pass');
  if (!(policy.net_pf >= 1.25)) failures.push('net_pf');
  if (!(policy.net_expectancy_percent >= 0.15)) failures.push('net_expectancy_percent');
  if ((policy.total_windows ?? 0) < 6) failures.push('total_windows');
  if ((policy.net_positive_windows ?? 0) < 4) failures.push('net_positive_windows');
  if (!(policy.net_positive_window_ratio >= 2 / 3)) failures.push('net_positive_window_ratio');
  if ((policy.symbol_breadth ?? 0) < 8) failures.push('symbol_breadth');
  if (calibration.status !== 'PASS') failures.push('calibration');
  if ((policy.unique_event_symbol_concentration ?? Infinity) > 0.30) failures.push('unique_event_symbol_concentration');
  return gateResult(failures);
}

export function resolveM15Decision({
  freshEvidenceSufficient = true,
  c1Confirmation = false,
  absolutePromotion = false,
  d1Replication = false,
} = {}) {
  if (!freshEvidenceSufficient) return 'INSUFFICIENT_FRESH_EVIDENCE';
  if (c1Confirmation && absolutePromotion) return 'CAUSAL_SPARSIFICATION_SHADOW_CANDIDATE';
  if (c1Confirmation) return 'CAUSAL_SPARSIFICATION_CONFIRMED_NOT_PROMOTABLE';
  if (d1Replication) return 'RETROSPECTIVE_SPARSIFICATION_REPLICATED_ONLY';
  return 'SPARSIFICATION_NOT_CONFIRMED';
}

export function buildCausalityGap(d1Records = [], c1Records = []) {
  const d1Keys = new Set(d1Records.map(selectionKey));
  const c1Keys = new Set(c1Records.map(selectionKey));
  const overlap = [...d1Keys].filter(key => c1Keys.has(key)).length;
  const d1Summary = summarizeReviewRecords(d1Records, { horizonHours: 8, costPercent: M15_COST_PERCENT });
  const c1Summary = summarizeReviewRecords(c1Records, { horizonHours: 8, costPercent: M15_COST_PERCENT });
  return {
    d1_event_count: d1Summary.independent_events,
    c1_event_count: c1Summary.independent_events,
    selected_symbol_direction_overlap_count: overlap,
    selected_symbol_direction_overlap_ratio: d1Keys.size ? round(overlap / d1Keys.size) : 0,
    gross_expectancy_difference_percent: round((c1Summary.gross_expectancy_percent ?? 0) - (d1Summary.gross_expectancy_percent ?? 0)),
    net_expectancy_difference_percent: round((c1Summary.net_expectancy_percent ?? 0) - (d1Summary.net_expectancy_percent ?? 0)),
    gross_pf_difference: round((c1Summary.gross_pf ?? 0) - (d1Summary.gross_pf ?? 0), 6),
    net_pf_difference: round((c1Summary.net_pf ?? 0) - (d1Summary.net_pf ?? 0), 6),
    diagnostic_only: true,
  };
}

export function buildDiscoveryRetention(freshD1 = {}) {
  const fields = [
    'gross_expectancy_percent',
    'net_expectancy_percent',
    'gross_pf',
    'net_pf',
    'gross_positive_windows',
    'net_positive_windows',
    'unique_event_symbol_concentration',
  ];
  const fresh = Object.fromEntries(fields.map(field => [field, freshD1[field] ?? null]));
  const deltas = Object.fromEntries(fields.map(field => {
    const current = finite(fresh[field]);
    const previous = finite(M15_DISCOVERY_REFERENCE[field]);
    return [field, current === null || previous === null ? null : round(current - previous)];
  }));
  return {
    frozen_m14_reference: { ...M15_DISCOVERY_REFERENCE },
    fresh_d1: fresh,
    fresh_delta_vs_m14: deltas,
    selection_policy_changed: false,
    feature_changed: false,
    causal_policy_changed: true,
  };
}

export function buildM15ConfigHash({
  baseMainSha = M15_BASE_MAIN_SHA,
  m14SourceSha = M15_M14_SOURCE_SHA,
  symbols = [],
  validationPlanHash = null,
  validationEventWindowMapHash = null,
  gates = {},
} = {}) {
  return hashConfig({
    base_main_sha: baseMainSha,
    research_version: M15_RESEARCH_VERSION,
    m14_source_sha: m14SourceSha,
    x8_candidate: M15_X8_CANDIDATE,
    validation_signal_start: M15_VALIDATION_SIGNAL_START,
    validation_signal_end: M15_VALIDATION_SIGNAL_END,
    outcome_data_end: M15_OUTCOME_DATA_END,
    configured_symbols: [...symbols].sort(),
    event_definition: 'fixed UTC 4h event; bucket close is last fully closed 1h snapshot',
    policies: M15_POLICY_ORDER,
    causal_bucket_close_breadth: M15_MIN_BUCKET_CLOSE_BREADTH,
    primary_horizon_hours: M15_PRIMARY_HORIZON_HOURS,
    round_trip_cost_percent: M15_COST_PERCENT,
    validation_window_count: M15_VALIDATION_WINDOW_COUNT,
    validation_plan_hash: validationPlanHash,
    validation_event_window_map_hash: validationEventWindowMapHash,
    bootstrap_repetitions: M15_BOOTSTRAP_REPETITIONS,
    bootstrap_seed: M15_BOOTSTRAP_SEED,
    moving_block_length_events: M15_MOVING_BLOCK_LENGTH,
    gates,
    final_holdout_outcomes_accessed: false,
    production_route_changed: false,
  });
}

export function compactPolicyMetrics(policy = {}) {
  const fields = [
    'signal_count',
    'independent_events',
    'symbol_breadth',
    'direction_breadth',
    'gross_expectancy_percent',
    'net_expectancy_percent',
    'gross_pf',
    'net_pf',
    'gross_positive_windows',
    'net_positive_windows',
    'gross_positive_window_ratio',
    'net_positive_window_ratio',
    'total_windows',
    'unique_event_symbol_concentration',
    'max_symbol_event_concentration',
    'avg_mfe_percent',
    'avg_mae_percent',
  ];
  return {
    ...Object.fromEntries(fields.map(field => [field, policy[field] ?? null])),
    standard_bootstrap: policy.standard_bootstrap || null,
    moving_block_bootstrap: policy.moving_block_bootstrap || null,
    assignment: policy.assignment
      ? {
        input_signal_count: policy.assignment.input_signal_count,
        assigned_signal_count: policy.assignment.assigned_signal_count,
        dropped_signal_count: policy.assignment.dropped_signal_count,
        input_independent_events: policy.assignment.input_independent_events,
        assigned_independent_events: policy.assignment.assigned_independent_events,
        dropped_independent_events: policy.assignment.dropped_independent_events,
        dropped_in_support_policy_records: policy.assignment.dropped_in_support_policy_records,
        input_event_ids_hash: policy.assignment.input_event_ids_hash,
        assigned_event_ids_hash: policy.assignment.assigned_event_ids_hash,
        dropped_event_ids_hash: policy.assignment.dropped_event_ids_hash,
        event_assignment_integrity: policy.assignment.event_assignment_integrity,
        validation_event_window_map_hash: policy.assignment.validation_event_window_map_hash,
      }
      : null,
  };
}

export function toPolicyReport(policy = {}, gate = null, {
  calibration = null,
  deployable = false,
  secondaryOnly = false,
} = {}) {
  return {
    ...compactPolicyMetrics(policy),
    gate: gate || { pass: false, failures: ['NOT_EVALUATED'] },
    calibration,
    deployable,
    secondary_only: secondaryOnly,
  };
}

export function formatM15Timestamp(value) {
  return iso(value);
}

export const M15_INTERNALS = Object.freeze({
  HOUR,
  FOUR_HOURS,
  finite,
  timestamp,
  eventId,
  recordTime,
  fixedEventBoundsFromId,
  grossOutcome,
  netOutcome,
  selectionKey,
});

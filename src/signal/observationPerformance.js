// Public-price reference outcomes only. No account, order or email operations.
import { OBSERVATION_RULE_VERSION } from './observation.js';

export const OBSERVATION_NOTIONAL_USDT = 100;
const MINUTE = 60_000;
const MAX_MINUTES = 1500;
const SIDE_COST = 0.0007; // 0.04% fee + 0.03% slippage, on entry notional.
const EVALUATION_VERSION = 'observation-reference-v1';

function number(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function time(value) {
  const numeric = number(value);
  if (numeric !== null) return numeric;
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

const iso = value => new Date(value).toISOString();
const observation = row => row?.raw_features?.observation;
const delivered = row => row?.delivery_status === 'delivered';

function eligible(row) {
  return observation(row)?.version === OBSERVATION_RULE_VERSION && delivered(row);
}

function reviewRange(row, now) {
  const metadata = observation(row);
  const deliveredTime = time(row.delivered_at);
  if (deliveredTime === null) throw new Error('Missing delivered timestamp');
  // A and OLD remain measurable after a ticker failure: their reference price
  // is the later public minute open, never the unknown quote or trigger close.
  const quoteTime = time(metadata?.reference_time) ?? deliveredTime;
  const entryStart = (Math.floor(Math.max(quoteTime, deliveredTime) / MINUTE) + 1) * MINUTE;
  const previous = metadata.evaluation;
  const checked = time(previous?.checked_until);
  if (checked !== null && (checked % MINUTE || checked < entryStart)) throw new Error('Invalid review cursor');
  const start = checked ?? entryStart;
  return { start, end: Math.min(Math.floor(now / MINUTE) * MINUTE, start + MAX_MINUTES * MINUTE), entryStart };
}

function initialEvaluation(row, now) {
  return {
    version: EVALUATION_VERSION,
    status: 'pending',
    notional_usdt: OBSERVATION_NOTIONAL_USDT,
    round_trip_cost_percent: SIDE_COST * 2 * 100,
    funding_timing: 'minute_bucket_before_new_entries',
    entry_time: null,
    entry_price: null,
    checked_until: null,
    net_pnl_usdt: null,
    net_pnl_percent: null,
    funding_pnl_usdt: 0,
    transaction_cost_usdt: 0,
    review_error: null,
    reviewed_at: iso(now),
    ...(observation(row)?.evaluation || {}),
  };
}

function failed(evaluation, error, now) {
  return { ...evaluation, review_error: error instanceof Error ? error.message : String(error), reviewed_at: iso(now) };
}

function parseCandle(row) {
  return {
    time: time(row?.open_time ?? row?.openTime ?? row?.[0]),
    open: number(row?.open ?? row?.[1]),
    high: number(row?.high ?? row?.[2]),
    low: number(row?.low ?? row?.[3]),
    close: number(row?.close ?? row?.[4]),
  };
}

/**
 * Process at most 1,500 completed minutes. checked_until is exclusive. Funding
 * input must cover the requested interval; an empty, verified response is valid.
 * Missing candles stop progress at the first gap, never after it.
 */
export function evaluateObservationRow(row, { now = Date.now(), candles, funding } = {}) {
  if (!eligible(row)) return null;
  const currentTime = time(now);
  if (currentTime === null) throw new Error('Valid review time required');
  const state = initialEvaluation(row, currentTime);
  if (state.status === 'closed' || state.status === 'invalid') return state;
  state.review_error = null;
  state.reviewed_at = iso(currentTime);
  let range;
  try { range = reviewRange(row, currentTime); }
  catch (error) { return failed(state, error, currentTime); }
  if (range.end <= range.start) return state;
  if (!Array.isArray(candles) || !Array.isArray(funding)) {
    return failed(state, 'Complete candle and funding arrays required', currentTime);
  }
  const direction = String(row.signal_direction ?? row.direction ?? row.signal ?? '').toUpperCase();
  const stop = number(row.stop_loss ?? row.stopLoss);
  const target = number(row.target_price ?? row.targetPrice);
  if (!['BUY', 'SELL'].includes(direction) || stop === null || target === null || stop <= 0 || target <= 0) {
    return { ...state, status: 'invalid', review_error: 'Invalid direction or fixed target/stop' };
  }
  const byTime = new Map();
  for (const raw of candles) {
    const candle = parseCandle(raw);
    if (candle.time === null || candle.time < range.start || candle.time >= range.end) continue;
    if (byTime.has(candle.time)) return failed(state, 'Duplicate minute candle', currentTime);
    byTime.set(candle.time, candle);
  }
  const payments = new Map();
  for (const payment of funding) {
    const timestamp = time(payment?.fundingTime ?? payment?.timestamp);
    const rate = number(payment?.fundingRate ?? payment?.rate);
    const mark = number(payment?.markPrice);
    if (timestamp === null || rate === null || mark === null || mark <= 0) {
      return failed(state, 'Invalid or missing funding timestamp, rate or mark price', currentTime);
    }
    const minute = Math.floor(timestamp / MINUTE) * MINUTE;
    if (minute < range.start || minute >= range.end) continue;
    if (payments.has(minute)) return failed(state, 'Duplicate funding minute', currentTime);
    payments.set(minute, { rate, mark });
  }
  let entry = number(state.entry_price);
  let entryTime = time(state.entry_time);
  let fundingPnl = number(state.funding_pnl_usdt);
  if (fundingPnl === null || (entry !== null && (entry <= 0 || entryTime === null))) {
    return failed(state, 'Invalid saved reference ledger', currentTime);
  }
  const long = direction === 'BUY';
  const grossAt = price => OBSERVATION_NOTIONAL_USDT / entry * (price - entry) * (long ? 1 : -1);
  for (let cursor = range.start; cursor < range.end; cursor += MINUTE) {
    const candle = byTime.get(cursor);
    if (!candle) return failed(state, `Missing minute ${iso(cursor)}`, currentTime);
    if (![candle.open, candle.high, candle.low, candle.close].every(value => value !== null && value > 0)
      || candle.low > Math.min(candle.open, candle.close)
      || candle.high < Math.max(candle.open, candle.close) || candle.low > candle.high) {
      return failed(state, `Invalid OHLC at ${iso(cursor)}`, currentTime);
    }
    if (entry === null) {
      if (long ? !(stop < candle.open && candle.open < target) : !(target < candle.open && candle.open < stop)) {
        return { ...state, status: 'invalid', review_error: null, invalid_reason: 'Reference quote already outside fixed target/stop',
          checked_until: iso(cursor), invalid_at: iso(cursor) };
      }
      entry = candle.open;
      entryTime = cursor;
      Object.assign(state, { status: 'open', entry_time: iso(cursor), entry_price: entry,
        transaction_cost_usdt: OBSERVATION_NOTIONAL_USDT * SIDE_COST });
    }
    const payment = payments.get(cursor);
    if (payment && cursor > entryTime) {
      fundingPnl += OBSERVATION_NOTIONAL_USDT / entry * payment.mark * payment.rate * (long ? -1 : 1);
    }
    state.funding_pnl_usdt = fundingPnl;
    const gapStop = long ? candle.open <= stop : candle.open >= stop;
    const gapTarget = long ? candle.open >= target : candle.open <= target;
    const stopHit = long ? candle.low <= stop : candle.high >= stop;
    const targetHit = long ? candle.high >= target : candle.low <= target;
    const gap = gapStop || gapTarget;
    if (gap || stopHit || targetHit) {
      const exitPrice = gap ? candle.open : stopHit ? stop : target;
      const costs = OBSERVATION_NOTIONAL_USDT * SIDE_COST * 2;
      const gross = grossAt(exitPrice);
      const net = gross - costs + fundingPnl;
      return { ...state, status: 'closed', checked_until: iso(cursor + MINUTE),
        exit_time: iso(gap ? cursor : cursor + MINUTE - 1), exit_price: exitPrice,
        exit_reason: gapStop ? 'stop_loss_gap' : gapTarget ? 'target_gap' : stopHit ? 'stop_loss' : 'target',
        ambiguous: !gap && stopHit && targetHit,
        gross_pnl_usdt: gross, transaction_cost_usdt: costs, funding_pnl_usdt: fundingPnl,
        net_pnl_usdt: net, net_pnl_percent: net / OBSERVATION_NOTIONAL_USDT * 100,
        unrealized_net_pnl_usdt: null, estimated_exit_cost_usdt: 0,
        hold_hours: ((gap ? cursor : cursor + MINUTE - 1) - entryTime) / 3_600_000 };
    }
    Object.assign(state, { checked_until: iso(cursor + MINUTE), mark_price: candle.close,
      unrealized_net_pnl_usdt: grossAt(candle.close) - OBSERVATION_NOTIONAL_USDT * SIDE_COST * 2 + fundingPnl,
      estimated_exit_cost_usdt: OBSERVATION_NOTIONAL_USDT * SIDE_COST,
      net_pnl_usdt: null, net_pnl_percent: null });
  }
  return state;
}

/** Dependency-injected public-data review; the caller owns durable storage. */
export async function refreshObservationRows(rows, {
  now = Date.now(), fetchCandles, fetchFunding, saveEvaluation, deadline = Infinity, maxRows = Infinity,
} = {}) {
  if (![fetchCandles, fetchFunding, saveEvaluation].every(value => typeof value === 'function')) {
    throw new TypeError('Candle/funding fetchers and evaluation persistence required');
  }
  const currentTime = time(now);
  if (currentTime === null) throw new Error('Valid review time required');
  const output = [];
  let attempted = 0;
  for (const row of rows) {
    const previous = observation(row)?.evaluation;
    if (!eligible(row) || ['closed', 'invalid'].includes(previous?.status)) { output.push(row); continue; }
    if (Date.now() >= deadline || attempted >= maxRows) { output.push(row); continue; }
    attempted++;
    let evaluation;
    try {
      const range = reviewRange(row, currentTime);
      const [candles, funding] = range.end > range.start
        ? await Promise.all([fetchCandles(row.symbol, range.start, range.end), fetchFunding(row.symbol, range.start, range.end)])
        : [[], []];
      evaluation = evaluateObservationRow(row, { now: currentTime, candles, funding });
    } catch (error) { evaluation = failed(initialEvaluation(row, currentTime), error, currentTime); }
    if (evaluation) {
      await saveEvaluation(row, evaluation);
      output.push({ ...row, raw_features: { ...row.raw_features,
        observation: { ...observation(row), evaluation } } });
    } else output.push(row);
  }
  return output;
}

/** Mutually exclusive final strategy attribution; overlapping groups must not be added. */
export function summarizeObservationPerformance(rows, { candidateId, strategy, now = Date.now() } = {}) {
  if (!['A', 'B', 'OLD'].includes(candidateId)) throw new Error('Candidate A, B or OLD required');
  const currentTime = time(now);
  if (currentTime === null) throw new Error('Valid summary time required');
  const selected = rows.filter(row => eligible(row)
    && observation(row).candidates?.includes(candidateId) && (!strategy || row.strategy === strategy));
  const summary = { candidateId, strategy: strategy ?? null, referenceNotionalUSDT: OBSERVATION_NOTIONAL_USDT,
    total: selected.length, closed: 0, open: 0, pending: 0, invalid: 0, netPnlUSDT: null,
    incomplete: false, firstObservedAt: null, asOf: iso(currentTime), sampleStatus: 'no_samples' };
  let closedNet = 0;
  const times = [];
  for (const row of selected) {
    const metadata = observation(row);
    const referenceTime = time(metadata.reference_time) ?? time(row.delivered_at);
    if (referenceTime !== null) times.push(referenceTime);
    const state = metadata.evaluation;
    const net = number(state?.net_pnl_usdt);
    if (state?.status === 'closed' && net !== null && state.version === EVALUATION_VERSION && !state.review_error) {
      summary.closed++;
      closedNet += net;
    } else if (state?.status === 'invalid') summary.invalid++;
    else if (state?.status === 'open') summary.open++;
    else summary.pending++;
    if (state && state.version !== EVALUATION_VERSION) summary.incomplete = true;
    if (state?.review_error || (state?.status === 'closed' && net === null)) summary.incomplete = true;
    if (state?.status === 'open' && (time(state.checked_until) ?? 0) < Math.floor(currentTime / MINUTE) * MINUTE) summary.incomplete = true;
    if (!state || state.status === 'pending') {
      try {
        const range = reviewRange(row, currentTime);
        if (range.end > range.start) summary.incomplete = true;
      } catch { summary.incomplete = true; }
    }
  }
  summary.netPnlUSDT = summary.closed ? closedNet : null;
  summary.firstObservedAt = times.length ? iso(Math.min(...times)) : null;
  if (summary.total) summary.sampleStatus = summary.incomplete ? 'incomplete' : summary.closed ? 'available' : 'pending';
  return summary;
}

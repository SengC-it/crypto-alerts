// Signal-only observation orchestration; no trading credentials or orders.
import { enrichObservationSignals } from './observation.js';
import { refreshObservationRows, summarizeObservationPerformance } from './observationPerformance.js';
import { getCandles, getFundingHistory, getPrice } from '../websocket/rest.js';

export const OBSERVATION_HISTORY = {
  start: '2026-09-08', end: '2026-10-31', capitalUSDT: 10000,
  byCandidate: {
    A: { netPnlUSDT: -71.97721951955995, returnPercent: -0.7197721951955995, trades: 103 },
    B: { netPnlUSDT: -51.067336427449824, returnPercent: -0.5106733642744983, trades: 60 },
  },
};

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Observation refresh timed out')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function loadObservationPerformance(store, { now = Date.now() } = {}) {
  try {
    const rows = (await store.getObservationSignals()).toSorted((left, right) => {
      const lastReview = row => Date.parse(row.raw_features?.observation?.evaluation?.reviewed_at || row.delivered_at) || 0;
      return lastReview(left) - lastReview(right);
    });
    const updated = await refreshObservationRows(rows, {
      now, deadline: Date.now() + 6000, maxRows: 4,
      fetchCandles: (symbol, start, end) => bounded(getCandles(symbol, '1m', 1500, { startTime: start, endTime: end - 1 })),
      fetchFunding: (symbol, start, end) => bounded(getFundingHistory(symbol, start, end)),
      saveEvaluation: (row, evaluation) => store.saveObservationEvaluation(row, evaluation),
    });
    return { rows: updated, available: true };
  } catch (error) {
    console.warn('[Observation] Performance unavailable:', error.message);
    return { rows: [], available: false };
  }
}

export async function prepareObservationDelivery(signals, {
  store, performance, now = Date.now(), priceFetcher = getPrice, clock = Date.now,
  keepOriginal = true,
} = {}) {
  if (!signals.length) return [];
  const history = performance || await loadObservationPerformance(store, { now });
  const symbol = signals[0].symbol;
  let referencePrice = null, referenceTime = null;
  try {
    const quote = await priceFetcher(symbol);
    const price = Number(quote?.price);
    if (!Number.isFinite(price) || price <= 0) throw new Error('Invalid current quote');
    referencePrice = price;
    referenceTime = new Date(clock()).toISOString();
  } catch (error) {
    console.warn('[Observation] Quote unavailable:', error.message);
  }
  const candidates = enrichObservationSignals(signals, { referencePrice, referenceTime });
  // enrichObservationSignals clones its input; match by immutable trigger identity.
  const key = signal => `${signal.symbol}:${signal.strategy}:${signal.signal}:${signal.candle_close_time || signal.signal_timestamp}`;
  const byKey = new Map(candidates.map(signal => [key(signal), signal]));
  const output = keepOriginal ? signals.map(signal => byKey.get(key(signal)) || {
    ...signal,
    raw_features: { ...signal.raw_features, observation: {
      version: 'ab-observation-v1', candidates: ['OLD'],
      trigger_time: signal.candle_close_time || signal.signal_timestamp,
      reference_price: referencePrice, reference_time: referenceTime,
    } },
  }) : candidates;
  for (const signal of output) {
    if (signal.observation_only) {
      signal.observation_history = OBSERVATION_HISTORY;
      signal.raw_features.observation.candidates = ['OLD', ...signal.observation_candidates];
    }
    signal.observation_performance = (signal.observation_candidates || ['OLD']).map(candidateId => {
      const summary = summarizeObservationPerformance(history.rows, { candidateId, strategy: signal.strategy, now });
      return { ...summary, candidateId, strategy: signal.strategy,
        closedTrades: summary.closed, openSignals: summary.open,
        pendingSignals: summary.pending, invalidSignals: summary.invalid,
        complete: history.available && !summary.incomplete,
        startedAt: summary.firstObservedAt,
      };
    });
  }
  return output;
}

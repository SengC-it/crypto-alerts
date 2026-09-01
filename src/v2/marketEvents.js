// Market-event clustering and candidate ranking for the M1 shadow lane.

import { hashConfig } from '../lineage.js';

export const SHADOW_STATUS = 'SHADOW';
export const RANKING_BUCKETS = Object.freeze(['ACTION_CANDIDATE', 'WATCH', 'SHADOW']);

const EVENT_WINDOW_MS = 4 * 60 * 60 * 1000;

function timeValue(value) {
  const candidate = value?.trigger_time ?? value?.signal_timestamp ?? value;
  if (Number.isFinite(Number(candidate))) return Number(candidate);
  const parsed = Date.parse(candidate || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function direction(value) {
  return String(value?.direction ?? value?.signal ?? '').toUpperCase();
}

function eventBucket(timestamp, eventWindowMs) {
  return Math.floor(timestamp / eventWindowMs) * eventWindowMs;
}

export function marketEventId(bucket, { eventWindowMs = EVENT_WINDOW_MS } = {}) {
  return `m1-event-${hashConfig({ bucket, event_window_ms: eventWindowMs }).slice(0, 16)}`;
}

export function groupMarketEvents(candidates = [], {
  eventWindowMs = EVENT_WINDOW_MS,
} = {}) {
  const groups = new Map();
  candidates.forEach((candidate, index) => {
    const timestamp = timeValue(candidate);
    const bucket = timestamp === null ? `unknown-${index}` : eventBucket(timestamp, eventWindowMs);
    if (!groups.has(bucket)) groups.set(bucket, []);
    groups.get(bucket).push({ candidate, index, timestamp });
  });
  return [...groups.entries()].sort((a, b) => {
    if (typeof a[0] === 'number' && typeof b[0] === 'number') return a[0] - b[0];
    return String(a[0]).localeCompare(String(b[0]));
  }).map(([bucket, members]) => {
    const uniqueSymbols = new Set(members.map(item => item.candidate.symbol).filter(Boolean));
    const byDirection = new Map();
    for (const member of members) {
      const key = direction(member.candidate) || 'UNKNOWN';
      if (!byDirection.has(key)) byDirection.set(key, []);
      byDirection.get(key).push(member);
    }
    const id = typeof bucket === 'number' ? marketEventId(bucket, { eventWindowMs }) : marketEventId(String(bucket), { eventWindowMs });
    return {
      market_event_id: id,
      bucket,
      market_breadth: uniqueSymbols.size,
      candidate_count: members.length,
      directions: Object.fromEntries([...byDirection.entries()].map(([key, values]) => [key, values.length])),
      members,
    };
  });
}

function rankValue(candidate) {
  const edge = Number(candidate.edge_score);
  const raw = Number(candidate.raw_score);
  return Number.isFinite(edge) ? edge : Number.isFinite(raw) ? raw : 0;
}

/**
 * Assigns a ranking bucket while keeping every candidate's externally visible
 * status as SHADOW. No candidate is dropped for being outside the top rank.
 */
export function rankShadowCandidates(candidates = [], options = {}) {
  const events = groupMarketEvents(candidates, options);
  const ranked = [];
  for (const event of events) {
    const sortedMembers = [...event.members].sort((a, b) => {
      return rankValue(b.candidate) - rankValue(a.candidate)
        || String(a.candidate.symbol).localeCompare(String(b.candidate.symbol))
        || String(a.candidate.setup_family).localeCompare(String(b.candidate.setup_family));
    });
    const topPerDirection = new Map();
    for (const member of sortedMembers) {
      const key = direction(member.candidate) || 'UNKNOWN';
      topPerDirection.set(key, (topPerDirection.get(key) || 0) + 1);
      const rank = topPerDirection.get(key);
      const sameDirectionBreadth = event.directions[key] || 0;
      const rankingBucket = rank === 1 && sameDirectionBreadth >= 3
        ? 'ACTION_CANDIDATE'
        : rank <= 2
          ? 'WATCH'
          : 'SHADOW';
      ranked.push({
        ...member.candidate,
        market_event_id: event.market_event_id,
        market_breadth: event.market_breadth,
        same_direction_breadth: sameDirectionBreadth,
        cluster_size: event.candidate_count,
        cluster_rank: rank,
        ranking_bucket: rankingBucket,
        status: SHADOW_STATUS,
        shadow_status: SHADOW_STATUS,
      });
    }
  }
  return ranked.sort((a, b) => {
    return timeValue(a) - timeValue(b)
      || String(a.symbol).localeCompare(String(b.symbol))
      || String(a.setup_family).localeCompare(String(b.setup_family));
  });
}

export function attachMarketEvents(candidates, options) {
  return rankShadowCandidates(candidates, options);
}

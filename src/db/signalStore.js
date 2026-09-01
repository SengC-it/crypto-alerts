// Signal storage with deduplication and explicit delivery state transitions.

import { CONFIG } from '../config.js';
import { annotateSignalPriority } from '../strategies/signalPriority.js';

function signalDirection(signal) {
  return signal?.signal || signal?.direction || signal?.signal_direction;
}

function signalScore(signal) {
  const value = signal?.score ?? signal?.raw_score ?? signal?.confidence ?? 0;
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function trackingStatus(priorityAction) {
  return priorityAction === 'trade_candidate'
    ? 'open'
    : priorityAction === 'watch_only'
      ? 'watch_only'
      : 'ignored';
}

function asErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Preserve the baseline storage projection used by the existing dashboard.
 * Runtime persistence uses _toRow below so email_sent_at is only set after a
 * successful email delivery.
 */
export function prepareSignalForStorage(signal, { dedupeKey, now = new Date().toISOString() } = {}) {
  const annotated = annotateSignalPriority(signal);
  const priorityAction = annotated.priorityAction;

  return {
    dedupe_key: dedupeKey || signal.symbol + ':' + signal.strategy + ':' + signalDirection(signal),
    symbol: signal.symbol,
    strategy: signal.strategy,
    signal_direction: signalDirection(signal),
    confidence: signal.confidence,
    score: signalScore(signal),
    priority: annotated.priority,
    priority_label: annotated.priorityLabel,
    priority_action: priorityAction,
    reason: signal.reason,
    suggested_entry: signal.suggestedEntry,
    stop_loss: signal.stopLoss,
    target_price: signal.targetPrice,
    risk_reward_ratio: signal.riskRewardRatio,
    indicators: signal.indicators,
    email_sent_at: null,
    tracking_status: trackingStatus(priorityAction),
    created_at: now,
  };
}

export class SignalStore {
  constructor({ config = CONFIG, supabaseClient } = {}) {
    this.config = config;
    this.memoryStore = new Map();
    this.supabase = supabaseClient ?? null;
    this.initError = null;
    this._initPromise = null;

    if (supabaseClient === undefined && config.SUPABASE?.ENABLED) {
      this._initPromise = this._initSupabase();
    }
  }

  async _ready() {
    if (this._initPromise) await this._initPromise;
    if (this.config.SUPABASE?.ENABLED && !this.supabase) {
      throw new Error('Supabase is configured but unavailable', {
        cause: this.initError || undefined,
      });
    }
  }

  async _initSupabase() {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      let options = {};
      try {
        const wsModule = await import('ws');
        options = {
          realtime: {
            transport: wsModule.default || wsModule.WebSocket || wsModule,
          },
        };
      } catch {
        // Realtime transport is optional for persistence.
      }
      this.supabase = createClient(this.config.SUPABASE.URL, this.config.SUPABASE.KEY, options);
      console.log('[DB] Supabase connected');
    } catch (error) {
      this.initError = error;
      this.supabase = null;
      console.error('[DB] Supabase init failed:', error.message);
    }
  }

  _dedupeKey(signal) {
    return signal.symbol + ':' + signal.strategy + ':' + signalDirection(signal);
  }

  _getCooldownMinutes(symbol) {
    for (const tier of Object.values(this.config.MONITOR_TIERS || {})) {
      if (tier.symbols?.includes(symbol)) return tier.cooldownMinutes;
    }
    return 240;
  }

  _toRow(signal, { dedupeKey, now }) {
    const annotated = annotateSignalPriority(signal);
    const direction = signalDirection(signal);
    const score = signalScore(signal);
    const lineage = signal.lineage || {};

    return {
      dedupe_key: dedupeKey || this._dedupeKey(signal),
      symbol: signal.symbol,
      strategy: signal.strategy,
      signal_direction: direction,
      direction,
      confidence: Number(signal.confidence || 0),
      score,
      raw_score: signal.raw_score ?? signal.rawScore ?? score,
      priority: annotated.priority,
      priority_label: annotated.priorityLabel,
      priority_action: annotated.priorityAction,
      reason: signal.reason ?? null,
      suggested_entry: signal.suggestedEntry ?? signal.entry_reference ?? null,
      entry_reference: signal.entryReference ?? signal.entry_reference ?? signal.suggestedEntry ?? null,
      stop_loss: signal.stopLoss ?? signal.stop_loss ?? null,
      target_price: signal.targetPrice ?? signal.target_price ?? null,
      risk_reward_ratio: signal.riskRewardRatio ?? signal.risk_reward_ratio ?? null,
      indicators: signal.indicators ?? null,
      model_version: signal.model_version ?? signal.modelVersion ?? lineage.model_version ?? null,
      commit_sha: signal.commit_sha ?? signal.commitSha ?? lineage.commit_sha ?? null,
      config_hash: signal.config_hash ?? signal.configHash ?? lineage.config_hash ?? null,
      signal_engine_version: signal.signal_engine_version ?? signal.signalEngineVersion ?? lineage.signal_engine_version ?? null,
      generated_at: signal.generated_at ?? signal.generatedAt ?? lineage.generated_at ?? now,
      signal_timestamp: signal.signal_timestamp ?? signal.signalTimestamp ?? null,
      candle_open_time: signal.candle_open_time ?? signal.candleOpenTime ?? null,
      candle_close_time: signal.candle_close_time ?? signal.candleCloseTime ?? null,
      timeframe: signal.timeframe ?? null,
      regime: signal.regime ?? null,
      volatility_regime: signal.volatility_regime ?? signal.volatilityRegime ?? null,
      raw_features: signal.raw_features ?? signal.rawFeatures ?? null,
      contributing_evidence: signal.contributing_evidence ?? signal.contributingEvidence ?? null,
      rejected_evidence: signal.rejected_evidence ?? signal.rejectedEvidence ?? null,
      filter_reasons: signal.filter_reasons ?? signal.filterReasons ?? null,
      signal_status: 'persisted',
      delivered_at: null,
      delivery_status: 'pending',
      delivery_error: null,
      email_sent_at: null,
      tracking_status: trackingStatus(annotated.priorityAction),
      created_at: now,
    };
  }

  _remember(row, signal = row) {
    const key = row.dedupe_key || this._dedupeKey(signal);
    this.memoryStore.set(key, {
      signal,
      row,
      timestamp: Date.parse(row.created_at) || Date.now(),
    });
    this._cleanupMemory();
  }

  _cleanupMemory() {
    const cooldowns = Object.values(this.config.MONITOR_TIERS || {})
      .map(tier => Number(tier.cooldownMinutes) || 0);
    const maxCooldown = Math.max(240, ...cooldowns) * 60 * 1000 * 2;
    const now = Date.now();
    for (const [key, value] of this.memoryStore) {
      if (now - value.timestamp > maxCooldown) this.memoryStore.delete(key);
    }
  }

  async _persistUpdate(row, update) {
    const next = { ...row, ...update };
    if (this.supabase) {
      let query = this.supabase.from('crypto_signals').update(update);
      if (row.id !== undefined && row.id !== null) {
        query = query.eq('id', row.id);
      } else {
        query = query.eq('dedupe_key', row.dedupe_key).eq('created_at', row.created_at);
      }
      const result = await query.select('id');
      if (result?.error) throw result.error;
      if (!Array.isArray(result?.data) || result.data.length === 0) {
        throw new Error('Supabase update matched no signal row');
      }
    }
    const cached = this.memoryStore.get(row.dedupe_key);
    this._remember(next, cached?.signal || row);
    return next;
  }

  async isDuplicate(signal) {
    await this._ready();
    const key = this._dedupeKey(signal);
    const cooldownMs = this._getCooldownMinutes(signal.symbol) * 60 * 1000;
    const now = Date.now();
    const cached = this.memoryStore.get(key);

    if (cached
      && (now - cached.timestamp) < cooldownMs
      && cached.row.delivery_status !== 'delivery_failed') {
      return true;
    }

    if (this.supabase) {
      const since = new Date(now - cooldownMs).toISOString();
      const result = await this.supabase
        .from('crypto_signals')
        .select('id,signal_status,delivery_status,created_at')
        .eq('dedupe_key', key)
        .gte('created_at', since)
        .order('created_at', { ascending: false })
        .limit(1);
      if (result?.error) throw result.error;
      const row = result?.data?.[0];
      if (row && row.delivery_status !== 'delivery_failed') {
        this._remember({ ...row, dedupe_key: key }, signal);
        return true;
      }
    }

    return false;
  }

  async save(signal) {
    await this._ready();
    const key = this._dedupeKey(signal);
    const now = new Date().toISOString();
    const row = this._toRow(signal, { dedupeKey: key, now });

    if (this.supabase) {
      const result = await this.supabase
        .from('crypto_signals')
        .insert(row)
        .select('*')
        .single();
      if (result?.error) throw result.error;
      if (!result?.data) throw new Error('Supabase insert returned no signal row');
      Object.assign(row, result.data);
    }

    this._remember(row, signal);
    return row;
  }

  async markDeliveryPending(record) {
    await this._ready();
    const row = this._coerceRow(record);
    return this._persistUpdate(row, {
      signal_status: 'delivery_pending',
      delivery_status: 'pending',
      delivery_error: null,
    });
  }

  async markDelivered(record, deliveredAt = new Date().toISOString()) {
    await this._ready();
    const row = this._coerceRow(record);
    return this._persistUpdate(row, {
      signal_status: 'delivered',
      delivery_status: 'delivered',
      delivered_at: deliveredAt,
      email_sent_at: deliveredAt,
      delivery_error: null,
    });
  }

  async markDeliveryFailed(record, error) {
    await this._ready();
    const row = this._coerceRow(record);
    return this._persistUpdate(row, {
      signal_status: 'delivery_failed',
      delivery_status: 'delivery_failed',
      delivery_error: asErrorMessage(error),
    });
  }

  _coerceRow(record) {
    if (record?.dedupe_key && record?.signal_status) return record;
    const key = record?.dedupe_key || this._dedupeKey(record);
    const cached = this.memoryStore.get(key);
    if (cached?.row) return cached.row;
    return this._toRow(record, { dedupeKey: key, now: new Date().toISOString() });
  }

  async getRecentSignals(symbol, limit = 10) {
    await this._ready();
    if (this.supabase) {
      const result = await this.supabase
        .from('crypto_signals')
        .select('*')
        .eq('symbol', symbol)
        .order('created_at', { ascending: false })
        .limit(limit);
      if (result?.error) throw result.error;
      return result?.data || [];
    }

    return [...this.memoryStore.values()]
      .map(value => value.row)
      .filter(row => row.symbol === symbol)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, limit);
  }
}

export const signalStore = new SignalStore();

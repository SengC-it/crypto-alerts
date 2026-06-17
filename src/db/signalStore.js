// Signal Storage - 信号去重与存储模块
// 支持内存存储和 Supabase 持久化

import { CONFIG } from '../config.js';

class SignalStore {
  constructor() {
    /** @type {Map<string, {signal: object, timestamp: number}>} */
    this.memoryStore = new Map();
    this.supabase = null;

    if (CONFIG.SUPABASE.ENABLED) {
      this._initSupabase();
    }
  }

  async _initSupabase() {
    try {
      const { createClient } = await import('@supabase/supabase-js');
      this.supabase = createClient(CONFIG.SUPABASE.URL, CONFIG.SUPABASE.KEY);
      await this._ensureTable();
      console.log('[DB] Supabase connected');
    } catch (err) {
      console.warn('[DB] Supabase init failed, falling back to memory:', err.message);
      this.supabase = null;
    }
  }

  async _ensureTable() {
    if (!this.supabase) return;

    // 尝试创建表（如果不存在）
    const { error } = await this.supabase.rpc('ensure_signals_table', {});
    if (error) {
      // 如果 RPC 不存在，忽略（表可能已创建）
      console.log('[DB] Table ensure skipped (may already exist)');
    }
  }

  /**
   * 生成信号去重 key
   * 同一个 symbol + strategy + signal 方向 在冷却期内不会重复发送
   */
  _dedupeKey(signal) {
    return `${signal.symbol}:${signal.strategy}:${signal.signal}`;
  }

  /**
   * 获取某个币种所属档位的冷却时间（分钟）
   */
  _getCooldownMinutes(symbol) {
    for (const tier of Object.values(CONFIG.MONITOR_TIERS)) {
      if (tier.symbols.includes(symbol)) {
        return tier.cooldownMinutes;
      }
    }
    // 默认 240 分钟
    return 240;
  }

  /**
   * 检查信号是否在冷却期内（去重）
   * @returns {boolean} true = 信号已被去重（应跳过），false = 新信号
   */
  async isDuplicate(signal) {
    const key = this._dedupeKey(signal);
    const cooldownMs = this._getCooldownMinutes(signal.symbol) * 60 * 1000;
    const now = Date.now();

    // 检查内存缓存
    const cached = this.memoryStore.get(key);
    if (cached && (now - cached.timestamp) < cooldownMs) {
      return true;
    }

    // 检查 Supabase
    if (this.supabase) {
      try {
        const since = new Date(now - cooldownMs).toISOString();
        const { data } = await this.supabase
          .from('crypto_signals')
          .select('id')
          .eq('dedupe_key', key)
          .gte('created_at', since)
          .limit(1);

        if (data && data.length > 0) {
          // 同步到内存缓存
          this.memoryStore.set(key, { signal, timestamp: now });
          return true;
        }
      } catch (err) {
        console.warn('[DB] Supabase dedupe check failed:', err.message);
      }
    }

    return false;
  }

  /**
   * 存储信号（写入内存 + Supabase）
   */
  async save(signal) {
    const key = this._dedupeKey(signal);
    const now = Date.now();

    // 内存存储
    this.memoryStore.set(key, { signal, timestamp: now });

    // 清理过期缓存（取最长冷却期 * 2 作为清理阈值）
    const maxCooldown = Math.max(
      ...Object.values(CONFIG.MONITOR_TIERS).map(t => t.cooldownMinutes)
    ) * 60 * 1000 * 2;
    for (const [k, v] of this.memoryStore) {
      if (Date.now() - v.timestamp > maxCooldown) {
        this.memoryStore.delete(k);
      }
    }

    // Supabase 持久化
    if (this.supabase) {
      try {
        await this.supabase.from('crypto_signals').insert({
          dedupe_key: key,
          symbol: signal.symbol,
          strategy: signal.strategy,
          signal_direction: signal.signal,
          confidence: signal.confidence,
          reason: signal.reason,
          suggested_entry: signal.suggestedEntry,
          stop_loss: signal.stopLoss,
          target_price: signal.targetPrice,
          risk_reward_ratio: signal.riskRewardRatio,
          indicators: signal.indicators,
          created_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('[DB] Supabase save failed:', err.message);
      }
    }
  }

  /**
   * 获取某个交易对的最近信号
   */
  async getRecentSignals(symbol, limit = 10) {
    if (this.supabase) {
      try {
        const { data, error } = await this.supabase
          .from('crypto_signals')
          .select('*')
          .eq('symbol', symbol)
          .order('created_at', { ascending: false })
          .limit(limit);

        if (!error && data) return data;
      } catch (err) {
        console.warn('[DB] Supabase query failed:', err.message);
      }
    }

    // 回退到内存
    const results = [];
    for (const [, v] of this.memoryStore) {
      if (v.signal.symbol === symbol) {
        results.push(v.signal);
      }
    }
    return results.slice(0, limit);
  }
}

export const signalStore = new SignalStore();

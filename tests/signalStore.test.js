// Tests for Signal Store (db module)

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { prepareSignalForStorage } from '../src/db/signalStore.js';

// We test the in-memory logic directly (no Supabase dependency)
// Since signalStore is a singleton with Supabase, we create a test version

class TestSignalStore {
  constructor(cooldownMinutes = 240) {
    this.memoryStore = new Map();
    this.cooldownMs = cooldownMinutes * 60 * 1000;
  }

  _dedupeKey(signal) {
    return `${signal.symbol}:${signal.strategy}:${signal.signal}`;
  }

  async isDuplicate(signal) {
    const key = this._dedupeKey(signal);
    const now = Date.now();
    const cached = this.memoryStore.get(key);
    if (cached && (now - cached.timestamp) < this.cooldownMs) {
      return true;
    }
    return false;
  }

  async save(signal) {
    const key = this._dedupeKey(signal);
    this.memoryStore.set(key, { signal, timestamp: Date.now() });
  }
}

describe('Signal Store - Deduplication', () => {
  let store;

  beforeEach(() => {
    store = new TestSignalStore(240);
  });

  it('should not deduplicate first signal', async () => {
    const signal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    const isDup = await store.isDuplicate(signal);
    assert.equal(isDup, false);
  });

  it('should deduplicate same signal within cooldown', async () => {
    const signal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    await store.save(signal);
    const isDup = await store.isDuplicate(signal);
    assert.equal(isDup, true);
  });

  it('should not deduplicate different signals', async () => {
    const buySignal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    const sellSignal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'SELL' };
    await store.save(buySignal);
    const isDup = await store.isDuplicate(sellSignal);
    assert.equal(isDup, false);
  });

  it('should not deduplicate same strategy on different symbols', async () => {
    const btcSignal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    const ethSignal = { symbol: 'ETHUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    await store.save(btcSignal);
    const isDup = await store.isDuplicate(ethSignal);
    assert.equal(isDup, false);
  });

  it('should not deduplicate different strategies on same symbol', async () => {
    const rsiSignal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    const macdSignal = { symbol: 'BTCUSDT', strategy: 'macd_cross', signal: 'BUY' };
    await store.save(rsiSignal);
    const isDup = await store.isDuplicate(macdSignal);
    assert.equal(isDup, false);
  });

  it('should allow signal after cooldown expires', async () => {
    const shortCooldownStore = new TestSignalStore(0); // 0 minutes = expired immediately
    const signal = { symbol: 'BTCUSDT', strategy: 'rsi_reversal', signal: 'BUY' };
    await shortCooldownStore.save(signal);

    // Wait a tiny bit to ensure timestamp difference
    await new Promise(r => setTimeout(r, 10));
    const isDup = await shortCooldownStore.isDuplicate(signal);
    // With 0 cooldown, should be expired
    assert.equal(isDup, false);
  });
});

describe('Signal Store - Persistence Enrichment', () => {
  it('prepares high priority signals with tracking metadata', () => {
    const now = '2026-07-03T12:00:00.000Z';
    const signal = {
      symbol: 'UNIUSDT',
      strategy: 'rsi_reversal',
      signal: 'SELL',
      confidence: 80,
      score: 82.5,
      suggestedEntry: 3.254,
      stopLoss: 3.3542,
      targetPrice: 3.0536,
    };

    const row = prepareSignalForStorage(signal, {
      dedupeKey: 'UNIUSDT:rsi_reversal:SELL',
      now,
    });

    assert.equal(row.priority, 'high');
    assert.equal(row.priority_label, 'High priority');
    assert.equal(row.priority_action, 'trade_candidate');
    assert.equal(row.score, 82.5);
    assert.equal(row.email_sent_at, null);
    assert.equal(row.tracking_status, 'open');
    assert.equal(row.signal_direction, 'SELL');
  });

  it('prepares watch signals as observation-only records', () => {
    const row = prepareSignalForStorage({
      symbol: 'BTCUSDT',
      strategy: 'volume_confirmation',
      signal: 'BUY',
      confidence: 60,
    }, {
      dedupeKey: 'BTCUSDT:volume_confirmation:BUY',
      now: '2026-07-03T12:05:00.000Z',
    });

    assert.equal(row.priority, 'watch');
    assert.equal(row.priority_action, 'watch_only');
    assert.equal(row.tracking_status, 'watch_only');
  });

  it('schema includes columns needed for signal performance tracking', () => {
    const schema = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

    for (const column of [
      'score',
      'priority',
      'priority_label',
      'priority_action',
      'email_sent_at',
      'tracking_status',
    ]) {
      assert.match(schema, new RegExp(`\\b${column}\\b`));
    }
  });
});

// Tests for Signal Store (db module)

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

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

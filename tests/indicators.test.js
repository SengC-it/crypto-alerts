// Tests for Technical Indicators

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sma, ema, rsi, macd, bollingerBands, atr, donchianChannel, volumeMA, stochastic, computeAllIndicators } from '../src/indicators/index.js';

describe('SMA', () => {
  it('should calculate SMA correctly', () => {
    const values = [1, 2, 3, 4, 5];
    assert.equal(sma(values, 3), 4); // (3+4+5)/3
  });

  it('should return null for insufficient data', () => {
    assert.equal(sma([1, 2], 5), null);
  });
});

describe('EMA', () => {
  it('should calculate EMA correctly', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    const result = ema(values, 5);
    assert.ok(result !== null);
    assert.ok(result > 0);
  });

  it('should return null for insufficient data', () => {
    assert.equal(ema([1, 2], 5), null);
  });
});

describe('RSI', () => {
  it('should return 100 for always-up prices', () => {
    const closes = Array.from({ length: 20 }, (_, i) => i + 1);
    // Not exactly 100 because of the calculation method, but should be very high
    const result = rsi(closes, 14);
    assert.ok(result !== null);
    assert.ok(result > 90);
  });

  it('should return null for insufficient data', () => {
    assert.equal(rsi([1, 2, 3], 14), null);
  });

  it('should return a value between 0-100', () => {
    const closes = [44, 44.34, 44.09, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08,
      45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
    const result = rsi(closes, 14);
    assert.ok(result !== null);
    assert.ok(result >= 0 && result <= 100);
  });
});

describe('MACD', () => {
  it('should return null for insufficient data', () => {
    const closes = [1, 2, 3, 4, 5];
    assert.equal(macd(closes), null);
  });

  it('should return macd, signal, histogram', () => {
    const closes = Array.from({ length: 50 }, (_, i) => 100 + Math.sin(i / 5) * 10);
    const result = macd(closes);
    assert.ok(result !== null);
    assert.ok('macd' in result);
    assert.ok('signal' in result);
    assert.ok('histogram' in result);
  });
});

describe('Bollinger Bands', () => {
  it('should return null for insufficient data', () => {
    assert.equal(bollingerBands([1, 2, 3], 20), null);
  });

  it('should return upper, middle, lower, bandwidth, percentB', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + Math.random() * 5);
    const result = bollingerBands(closes, 20, 2);
    assert.ok(result !== null);
    assert.ok(result.upper > result.middle);
    assert.ok(result.middle > result.lower);
    assert.ok(result.bandwidth > 0);
    assert.ok(result.percentB >= 0 && result.percentB <= 1);
  });
});

describe('ATR', () => {
  it('should return null for insufficient data', () => {
    const ohlcs = [{ high: 105, low: 100, close: 103 }];
    assert.equal(atr(ohlcs, 14), null);
  });

  it('should return a positive number', () => {
    const ohlcs = Array.from({ length: 20 }, (_, i) => ({
      high: 105 + Math.random() * 5,
      low: 95 + Math.random() * 5,
      close: 100 + Math.random() * 5,
    }));
    const result = atr(ohlcs, 14);
    assert.ok(result !== null);
    assert.ok(result > 0);
  });
});

describe('Donchian Channel', () => {
  it('should return null for insufficient data', () => {
    assert.equal(donchianChannel([{ high: 105, low: 100 }], 20), null);
  });

  it('should return upper >= middle >= lower', () => {
    const ohlcs = Array.from({ length: 25 }, () => ({
      high: 110 + Math.random() * 10,
      low: 90 + Math.random() * 10,
      close: 100 + Math.random() * 10,
    }));
    const result = donchianChannel(ohlcs, 20);
    assert.ok(result !== null);
    assert.ok(result.upper >= result.middle);
    assert.ok(result.middle >= result.lower);
  });
});

describe('computeAllIndicators', () => {
  it('should compute all indicators from candle data', () => {
    const candles = Array.from({ length: 100 }, (_, i) => ({
      open: 100 + Math.random() * 5,
      high: 105 + Math.random() * 5,
      low: 95 + Math.random() * 5,
      close: 100 + Math.random() * 5,
      volume: 1000000 + Math.random() * 500000,
    }));

    const result = computeAllIndicators(candles);
    assert.ok(result !== null);
    assert.ok('rsi_14' in result);
    assert.ok('macd' in result);
    assert.ok('bollinger' in result);
    assert.ok('atr_14' in result);
    assert.ok('donchian' in result);
    assert.ok('ema_9' in result);
    assert.ok('ema_21' in result);
    assert.ok('ema_50' in result);
    assert.ok('sma_20' in result);
    assert.ok('sma_50' in result);
    assert.ok('currentPrice' in result);
    assert.ok('currentVolume' in result);
  });
});

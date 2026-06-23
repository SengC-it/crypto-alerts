import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rsiReversal } from '../src/strategies/rsi_reversal.js';
import { volumeConfirmation } from '../src/strategies/volume_confirmation.js';
import { formatSignalScore } from '../src/email/notifier.js';

const baseIndicators = {
  currentPrice: 100,
  currentVolume: 265,
  volume_ma_20: 100,
  sma_20: 99,
  sma_50: 95,
  ema_9: 101,
  ema_21: 100,
  rsi_14: 39.1,
  atr_14: 2,
  macd: { histogram: -1, macd: -1, signal: 0 },
};

describe('Signal score precision', () => {
  it('keeps a decimal score for RSI signals while preserving integer confidence', () => {
    const signal = rsiReversal({ oversold: 35, overbought: 65, rsi_period: 14 }, baseIndicators);

    assert.equal(signal.confidence, 53);
    assert.equal(signal.score, 52.7);
  });

  it('keeps a decimal score for volume signals while preserving integer confidence', () => {
    const signal = volumeConfirmation(
      { volume_ma_period: 20, volume_multiplier: 1.3 },
      { ...baseIndicators, rsi_14: 55 }
    );

    assert.equal(signal.confidence, 53);
    assert.equal(signal.score, 53.0);
  });

  it('formats the decimal score for display and falls back to confidence for old signals', () => {
    assert.equal(formatSignalScore({ confidence: 53, score: 52.7 }), '52.7');
    assert.equal(formatSignalScore({ confidence: 53 }), '53');
  });
});

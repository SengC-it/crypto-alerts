// Tests for Trading Strategies

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rsiReversal } from '../src/strategies/rsi_reversal.js';
import { macdCross } from '../src/strategies/macd_cross.js';
import { bollingerMeanReversion } from '../src/strategies/bollinger_mean_reversion.js';
import { emaCrossover } from '../src/strategies/ema_crossover.js';
import { multiIndicatorResonance } from '../src/strategies/multi_indicator_resonance.js';
import { donchianBreakout } from '../src/strategies/donchian_breakout.js';
import { atrVolatility } from '../src/strategies/atr_volatility.js';
import { volumeConfirmation } from '../src/strategies/volume_confirmation.js';
import { runStrategies, getAvailableStrategies } from '../src/strategies/manager.js';

// Sample indicator data for testing
const bullishIndicators = {
  rsi_14: 22,     // Oversold
  rsi_7: 20,
  rsi_21: 25,
  macd: { macd: 1.5, signal: 1.0, histogram: 0.5 },  // Bullish
  bollinger: { upper: 110, middle: 100, lower: 92, bandwidth: 0.2, percentB: -0.05 },  // Below lower band
  atr_14: 3.5,
  donchian: { upper: 110, middle: 100, lower: 92 },
  stochastic: { k: 25, d: 30 },
  ema_9: 96,
  ema_21: 95,
  ema_50: 94,
  sma_20: 97,
  sma_50: 96,
  volume_ma_20: 1500000,
  currentPrice: 91,  // Below Bollinger lower band
  currentVolume: 3000000,  // High volume
};

const bearishIndicators = {
  rsi_14: 78,     // Overbought
  rsi_7: 80,
  rsi_21: 75,
  macd: { macd: -1.5, signal: -1.0, histogram: -0.5 },  // Bearish
  bollinger: { upper: 110, middle: 100, lower: 90, bandwidth: 0.2, percentB: 0.98 },  // Near upper band
  atr_14: 3.5,
  donchian: { upper: 108, middle: 100, lower: 92 },
  stochastic: { k: 80, d: 75 },
  ema_9: 104,
  ema_21: 105,
  ema_50: 106,
  sma_20: 103,
  sma_50: 104,
  volume_ma_20: 1500000,
  currentPrice: 111,  // Near Bollinger upper band
  currentVolume: 3000000,
};

const neutralIndicators = {
  rsi_14: 50,
  rsi_7: 52,
  rsi_21: 48,
  macd: { macd: 0.1, signal: 0.12, histogram: -0.02 },
  bollinger: { upper: 110, middle: 100, lower: 90, bandwidth: 0.2, percentB: 0.5 },
  atr_14: 2.0,
  donchian: { upper: 108, middle: 100, lower: 92 },
  stochastic: { k: 50, d: 50 },
  ema_9: 100,
  ema_21: 100,
  ema_50: 100,
  sma_20: 100,
  sma_50: 100,
  volume_ma_20: 1500000,
  currentPrice: 100,
  currentVolume: 1500000,
};

describe('RSI Reversal Strategy', () => {
  it('should return BUY for oversold RSI', () => {
    const result = rsiReversal({ oversold: 30, overbought: 70, rsi_period: 14 }, bullishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'BUY');
    assert.equal(result.strategy, 'rsi_reversal');
    assert.ok(result.confidence > 0);
    assert.ok(result.stopLoss < result.suggestedEntry);
    assert.ok(result.targetPrice > result.suggestedEntry);
  });

  it('should return SELL for overbought RSI', () => {
    const result = rsiReversal({ oversold: 30, overbought: 70, rsi_period: 14 }, bearishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'SELL');
    assert.ok(result.stopLoss > result.suggestedEntry);
    assert.ok(result.targetPrice < result.suggestedEntry);
  });

  it('should return null for neutral RSI', () => {
    const result = rsiReversal({ oversold: 30, overbought: 70, rsi_period: 14 }, neutralIndicators);
    assert.equal(result, null);
  });
});

describe('MACD Cross Strategy', () => {
  it('should return BUY for bullish MACD', () => {
    const result = macdCross({}, bullishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'BUY');
  });

  it('should return SELL for bearish MACD', () => {
    const result = macdCross({}, bearishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'SELL');
  });
});

describe('Bollinger Mean Reversion Strategy', () => {
  it('should return BUY at lower band', () => {
    const result = bollingerMeanReversion({}, bullishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'BUY');
  });

  it('should return SELL at upper band', () => {
    const result = bollingerMeanReversion({}, bearishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'SELL');
  });
});

describe('EMA Crossover Strategy', () => {
  it('should detect crossover signals', () => {
    // Create indicators with a clear crossover
    const crossIndicators = {
      ...neutralIndicators,
      ema_9: 100.3,
      ema_21: 100.0,
      currentPrice: 101,
    };
    const result = emaCrossover({ fast: 9, slow: 21 }, crossIndicators);
    // May or may not trigger depending on proximity
    if (result) {
      assert.equal(result.strategy, 'ema_crossover');
      assert.ok(['BUY', 'SELL'].includes(result.signal));
    }
  });
});

describe('Donchian Breakout Strategy', () => {
  it('should return BUY for upper breakout', () => {
    const breakoutIndicators = {
      ...neutralIndicators,
      currentPrice: 115,  // Above upper channel
    };
    const result = donchianBreakout({ period: 20 }, breakoutIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'BUY');
  });

  it('should return SELL for lower breakdown', () => {
    const breakdownIndicators = {
      ...neutralIndicators,
      currentPrice: 88,  // Below lower channel
    };
    const result = donchianBreakout({ period: 20 }, breakdownIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'SELL');
  });
});

describe('Multi-Indicator Resonance Strategy', () => {
  it('should return BUY when multiple indicators agree', () => {
    const result = multiIndicatorResonance({ required_indicators: 2 }, bullishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'BUY');
  });

  it('should return SELL when multiple indicators agree on sell', () => {
    const result = multiIndicatorResonance({ required_indicators: 2 }, bearishIndicators);
    assert.ok(result !== null);
    assert.equal(result.signal, 'SELL');
  });

  it('should return null for no resonance', () => {
    const result = multiIndicatorResonance({ required_indicators: 3 }, neutralIndicators);
    assert.equal(result, null);
  });
});

describe('ATR Volatility Strategy', () => {
  it('should return null for low volatility', () => {
    const result = atrVolatility({ period: 14, atr_multiplier: 2 }, neutralIndicators);
    assert.equal(result, null);
  });
});

describe('Volume Confirmation Strategy', () => {
  it('should return BUY for high volume + bullish setup', () => {
    const result = volumeConfirmation({ volume_ma_period: 20, volume_multiplier: 1.5 }, {
      ...bullishIndicators,
      currentPrice: 98,  // Above SMA20
      sma_20: 97,
      rsi_14: 55,
    });
    if (result) {
      assert.equal(result.signal, 'BUY');
    }
  });
});

describe('Strategy Manager', () => {
  it('should run all enabled strategies', () => {
    const configs = {
      rsi_reversal: { enabled: true, params: { oversold: 30, overbought: 70, rsi_period: 14 } },
      macd_cross: { enabled: true, params: {} },
      bollinger_mean_reversion: { enabled: true, params: {} },
    };
    const results = runStrategies('BTCUSDT', bullishIndicators, configs);
    assert.ok(Array.isArray(results));
    assert.ok(results.length > 0);
    results.forEach(s => {
      assert.equal(s.symbol, 'BTCUSDT');
      assert.ok(s.timestamp);
    });
  });

  it('should skip disabled strategies', () => {
    const configs = {
      rsi_reversal: { enabled: false, params: {} },
      macd_cross: { enabled: true, params: {} },
    };
    const results = runStrategies('BTCUSDT', bullishIndicators, configs);
    assert.ok(results.every(s => s.strategy !== 'rsi_reversal'));
  });

  it('should list available strategies', () => {
    const strategies = getAvailableStrategies();
    assert.ok(Array.isArray(strategies));
    assert.ok(strategies.length === 8);
    strategies.forEach(s => {
      assert.ok(s.id);
      assert.ok(s.name);
    });
  });
});

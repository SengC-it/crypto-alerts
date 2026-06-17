// Strategy Manager - Registry and Runner

import { rsiReversal } from './rsi_reversal.js';
import { macdCross } from './macd_cross.js';
import { bollingerMeanReversion } from './bollinger_mean_reversion.js';
import { emaCrossover } from './ema_crossover.js';
import { multiIndicatorResonance } from './multi_indicator_resonance.js';
import { donchianBreakout } from './donchian_breakout.js';
import { atrVolatility } from './atr_volatility.js';
import { volumeConfirmation } from './volume_confirmation.js';

const STRATEGY_MAP = {
  rsi_reversal: { fn: rsiReversal, name: 'RSI 反转策略' },
  macd_cross: { fn: macdCross, name: 'MACD 交叉策略' },
  bollinger_mean_reversion: { fn: bollingerMeanReversion, name: '布林带均值回归' },
  ema_crossover: { fn: emaCrossover, name: 'EMA 双均线交叉' },
  multi_indicator_resonance: { fn: multiIndicatorResonance, name: '多指标共振' },
  donchian_breakout: { fn: donchianBreakout, name: '唐奇安通道突破' },
  atr_volatility: { fn: atrVolatility, name: 'ATR波动率' },
  volume_confirmation: { fn: volumeConfirmation, name: '成交量确认' },
};

/**
 * Run all enabled strategies for a given symbol
 */
export function runStrategies(symbol, indicators, strategyConfigs) {
  const signals = [];

  for (const [strategyKey, config] of Object.entries(strategyConfigs)) {
    if (!config.enabled) continue;

    const strategyDef = STRATEGY_MAP[strategyKey];
    if (!strategyDef) continue;

    try {
      const result = strategyDef.fn(config.params, indicators);
      if (result) {
        result.symbol = symbol;
        result.timestamp = new Date().toISOString();
        signals.push(result);
      }
    } catch (err) {
      console.error('[Strategy] Error in ' + strategyKey + ':', err.message);
    }
  }

  return signals;
}

/**
 * Get list of available strategies
 */
export function getAvailableStrategies() {
  return Object.entries(STRATEGY_MAP).map(([key, def]) => ({
    id: key,
    name: def.name,
  }));
}

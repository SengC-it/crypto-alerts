// Strategy Manager - Registry and Runner
// 含信号质量过滤: 矛盾过滤、置信度过滤、共振加权

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
 * 返回原始信号列表（不过滤），供回测引擎和通知系统各自过滤
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
 * 信号质量过滤
 * 1. 去除低置信度信号（默认 < 30%）
 * 2. 同币种矛盾信号过滤（同时 BUY+SELL → 取消双向）
 * 3. 多策略共振加权（同方向信号合并，置信度叠加）
 * 4. 如果有共振信号，优先返回共振信号
 */
export function filterSignals(signals, options = {}) {
  const {
    minConfidence = 30,         // 最低置信度
    filterConflicts = true,     // 过滤矛盾信号
    boostResonance = true,      // 共振加权
  } = options;

  if (!signals || signals.length === 0) return [];

  // Step 1: 置信度过滤
  let filtered = signals.filter(s => s.confidence >= minConfidence);
  if (filtered.length === 0) return [];

  // Step 2: 矛盾信号过滤
  if (filterConflicts) {
    const buyStrategies = new Set(filtered.filter(s => s.signal === 'BUY').map(s => s.strategy));
    const sellStrategies = new Set(filtered.filter(s => s.signal === 'SELL').map(s => s.strategy));

    if (buyStrategies.size > 0 && sellStrategies.size > 0) {
      // 检查是否是同一个策略既出BUY又出SELL（不可能，但防御性检查）
      // 如果不同策略给出相反方向 → 保留多数方向
      const buyCount = filtered.filter(s => s.signal === 'BUY').length;
      const sellCount = filtered.filter(s => s.signal === 'SELL').length;

      if (Math.abs(buyCount - sellCount) <= 1) {
        // 信号势均力敌，跳过所有信号
        return [];
      }
      // 否则保留多数方向
      const majorityDirection = buyCount > sellCount ? 'BUY' : 'SELL';
      filtered = filtered.filter(s => s.signal === majorityDirection);
    }
  }

  // Step 3: 多策略共振加权
  if (boostResonance && filtered.length > 1) {
    const buySignals = filtered.filter(s => s.signal === 'BUY');
    const sellSignals = filtered.filter(s => s.signal === 'SELL');

    // 同方向的信号合并为一个共振信号
    const resonanceSignals = [];

    if (buySignals.length >= 2) {
      const totalConf = buySignals.reduce((s, sig) => s + sig.confidence, 0);
      const avgConf = Math.round(totalConf / buySignals.length);
      const boostConf = Math.min(avgConf + buySignals.length * 10, 98);

      resonanceSignals.push({
        strategy: 'resonance_BUY',
        name: `${buySignals.length}策略共振做多`,
        signal: 'BUY',
        confidence: boostConf,
        reason: buySignals.map(s => s.reason).join(' | '),
        indicators: Object.assign({}, ...buySignals.map(s => s.indicators || {})),
        suggestedEntry: buySignals[0].suggestedEntry,
        stopLoss: Math.min(...buySignals.map(s => s.stopLoss)),
        targetPrice: Math.max(...buySignals.map(s => s.targetPrice)),
        riskRewardRatio: '1:2+',
        contributingStrategies: buySignals.map(s => s.strategy),
        timestamp: buySignals[0].timestamp,
        symbol: buySignals[0].symbol,
      });
    }

    if (sellSignals.length >= 2) {
      const totalConf = sellSignals.reduce((s, sig) => s + sig.confidence, 0);
      const avgConf = Math.round(totalConf / sellSignals.length);
      const boostConf = Math.min(avgConf + sellSignals.length * 10, 98);

      resonanceSignals.push({
        strategy: 'resonance_SELL',
        name: `${sellSignals.length}策略共振做空`,
        signal: 'SELL',
        confidence: boostConf,
        reason: sellSignals.map(s => s.reason).join(' | '),
        indicators: Object.assign({}, ...sellSignals.map(s => s.indicators || {})),
        suggestedEntry: sellSignals[0].suggestedEntry,
        stopLoss: Math.max(...sellSignals.map(s => s.stopLoss)),
        targetPrice: Math.min(...sellSignals.map(s => s.targetPrice)),
        riskRewardRatio: '1:2+',
        contributingStrategies: sellSignals.map(s => s.strategy),
        timestamp: sellSignals[0].timestamp,
        symbol: sellSignals[0].symbol,
      });
    }

    // 如果有共振信号，替换原始信号
    if (resonanceSignals.length > 0) {
      // 保留单独的策略信号（置信度 >= 50），加入共振信号
      const standalone = filtered.filter(s => s.confidence >= 50 && !resonanceSignals.some(r => r.contributingStrategies.includes(s.strategy)));
      return [...standalone, ...resonanceSignals];
    }
  }

  return filtered;
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

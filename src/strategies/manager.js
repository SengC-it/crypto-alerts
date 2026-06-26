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
 * 1. 去除低置信度信号
 * 2. 做多趋势确认（价格>SMA50 才允许做多，避免逆势抄底）
 * 3. 同币种矛盾信号过滤
 * 4. 多策略共振加权
 */
export function filterSignals(signals, options = {}) {
  const {
    minConfidence = 40,         // 最低置信度
    filterConflicts = true,
    boostResonance = true,
    buyRequiresTrendConfirm = true,  // 做多需要趋势确认
    trendIndicators = null,     // 传入 { sma_50, currentPrice } 做趋势判断
  } = options;

  if (!signals || signals.length === 0) return [];

  // Step 1: 置信度过滤
  let filtered = signals.filter(s => s.confidence >= minConfidence);
  if (filtered.length === 0) return [];

  // Step 2: 做多趋势确认 — BUY 信号只在价格 > SMA50 时通过
  if (buyRequiresTrendConfirm && trendIndicators) {
    const { sma_50, currentPrice } = trendIndicators;
    if (sma_50 && currentPrice) {
      // 价格在 SMA50 下方 → 过滤低置信度 BUY（高置信度 < 70 的一律拒绝）
      if (currentPrice < sma_50) {
        filtered = filtered.filter(s => {
          if (s.signal === 'BUY' && s.confidence < 70) return false;
          return true;
        });
      }
    }
  }

  // Step 3: 矛盾信号过滤
  if (filterConflicts) {
    const buyCount = filtered.filter(s => s.signal === 'BUY').length;
    const sellCount = filtered.filter(s => s.signal === 'SELL').length;

    if (buyCount > 0 && sellCount > 0) {
      if (Math.abs(buyCount - sellCount) <= 1) {
        return [];
      }
      const majorityDirection = buyCount > sellCount ? 'BUY' : 'SELL';
      filtered = filtered.filter(s => s.signal === majorityDirection);
    }
  }

  // Step 4: 多策略共振加权
  if (boostResonance && filtered.length > 1) {
    const buySignals = filtered.filter(s => s.signal === 'BUY');
    const sellSignals = filtered.filter(s => s.signal === 'SELL');
    const resonanceSignals = [];

    if (buySignals.length >= 2) {
      const avgConf = Math.round(buySignals.reduce((s, sig) => s + sig.confidence, 0) / buySignals.length);
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
      const avgConf = Math.round(sellSignals.reduce((s, sig) => s + sig.confidence, 0) / sellSignals.length);
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

    if (resonanceSignals.length > 0) {
      const standalone = filtered.filter(s => s.confidence >= 50 && !resonanceSignals.some(r => r.contributingStrategies?.includes(s.strategy)));
      return [...standalone, ...resonanceSignals];
    }
  }

  return filtered;
}

export function applyProfitFilter(signals, options = {}) {
  const {
    enabled = true,
    allowDirections = null,
    excludeStrategies = [],
    minNetTargetPercent = 0,
    roundTripCostPercent = 0,
  } = options;

  if (!enabled || !signals || signals.length === 0) return signals || [];

  const allowed = allowDirections
    ? new Set(allowDirections.map(direction => direction.toUpperCase()))
    : null;
  const excluded = new Set(excludeStrategies);

  return signals
    .filter(signal => !allowed || allowed.has(signal.signal))
    .filter(signal => !excluded.has(signal.strategy))
    .map(signal => {
      const targetMovePercent = Math.abs((signal.targetPrice - signal.suggestedEntry) / signal.suggestedEntry) * 100;
      const netTargetPercent = +(targetMovePercent - roundTripCostPercent).toFixed(2);
      return {
        ...signal,
        grossTargetPercent: +targetMovePercent.toFixed(2),
        netTargetPercent,
        estimatedRoundTripCostPercent: +roundTripCostPercent.toFixed(2),
      };
    })
    .filter(signal => signal.netTargetPercent >= minNetTargetPercent);
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

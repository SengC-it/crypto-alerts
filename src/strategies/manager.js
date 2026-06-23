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
 * 2. 做多趋势确认（价格>SMA50+EMA9>EMA21 才允许做多，避免逆势抄底）
 * 3. 同币种矛盾信号过滤
 * 4. 多策略共振加权
 */
export function filterSignals(signals, options = {}) {
  const {
    minConfidence = 40,         // 最低置信度
    filterConflicts = true,
    boostResonance = true,
    buyRequiresTrendConfirm = true,  // 做多需要趋势确认
    trendIndicators = null,     // 传入 { sma_50, currentPrice, ema_9, ema_21 } 做趋势判断
  } = options;

  if (!signals || signals.length === 0) return [];

  // Step 1: 置信度过滤
  let filtered = signals.filter(s => s.confidence >= minConfidence);
  if (filtered.length === 0) return [];

  // Step 2: 做多趋势确认 — BUY 信号需要更强的趋势支撑
  // 回测数据显示 BUY 信号亏损严重，需加强过滤
  if (buyRequiresTrendConfirm && trendIndicators) {
    const { sma_50, currentPrice } = trendIndicators;
    if (sma_50 && currentPrice) {
      if (currentPrice < sma_50) {
        // 价格在 SMA50 下方 → 过滤所有 BUY（不论置信度）
        // 回测表明即使高置信度 BUY 在下降趋势中也大概率亏损
        filtered = filtered.filter(s => s.signal !== 'BUY');
      } else {
        // 价格在 SMA50 上方，但还需要检查 EMA 趋势
        // 如果 EMA9 < EMA21，说明短期趋势偏弱，过滤低置信度 BUY
        const emaTrendUp = trendIndicators.ema_9 && trendIndicators.ema_21 
          ? trendIndicators.ema_9 > trendIndicators.ema_21 
          : true;
        if (!emaTrendUp) {
          filtered = filtered.filter(s => {
            if (s.signal === 'BUY' && s.confidence < 75) return false;
            return true;
          });
        }
      }
    }
  }

  // Step 3: 矛盾信号过滤
  if (filterConflicts) {
    const buyCount = filtered.filter(s => s.signal === 'BUY').length;
    const sellCount = filtered.filter(s => s.signal === 'SELL').length;

    if (buyCount > 0 && sellCount > 0) {
      // 只有买卖信号数量完全相等时才全部过滤（完全矛盾）
      if (buyCount === sellCount) {
        return [];
      }
      // 保留多数方向信号
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
      const avgScore = buySignals.reduce((s, sig) => s + Number(sig.score ?? sig.confidence), 0) / buySignals.length;
      const boostConf = Math.min(avgConf + buySignals.length * 10, 98);
      const boostScore = Math.min(avgScore + buySignals.length * 10, 98);

      resonanceSignals.push({
        strategy: 'resonance_BUY',
        name: `${buySignals.length}策略共振做多`,
        signal: 'BUY',
        confidence: boostConf,
        score: +boostScore.toFixed(1),
        reason: buySignals.map(s => s.reason).join(' | '),
        indicators: Object.assign({}, ...buySignals.map(s => s.indicators || {})),
        suggestedEntry: buySignals[0].suggestedEntry,
        stopLoss: Math.min(...buySignals.map(s => s.stopLoss)),
        targetPrice: Math.max(...buySignals.map(s => s.targetPrice)),
        riskRewardRatio: 2.5,
        contributingStrategies: buySignals.map(s => s.strategy),
        timestamp: buySignals[0].timestamp,
        symbol: buySignals[0].symbol,
      });
    }

    if (sellSignals.length >= 2) {
      const avgConf = Math.round(sellSignals.reduce((s, sig) => s + sig.confidence, 0) / sellSignals.length);
      const avgScore = sellSignals.reduce((s, sig) => s + Number(sig.score ?? sig.confidence), 0) / sellSignals.length;
      const boostConf = Math.min(avgConf + sellSignals.length * 10, 98);
      const boostScore = Math.min(avgScore + sellSignals.length * 10, 98);

      resonanceSignals.push({
        strategy: 'resonance_SELL',
        name: `${sellSignals.length}策略共振做空`,
        signal: 'SELL',
        confidence: boostConf,
        score: +boostScore.toFixed(1),
        reason: sellSignals.map(s => s.reason).join(' | '),
        indicators: Object.assign({}, ...sellSignals.map(s => s.indicators || {})),
        suggestedEntry: sellSignals[0].suggestedEntry,
        stopLoss: Math.max(...sellSignals.map(s => s.stopLoss)),
        targetPrice: Math.min(...sellSignals.map(s => s.targetPrice)),
        riskRewardRatio: 2.5,
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

/**
 * Get list of available strategies
 */
export function getAvailableStrategies() {
  return Object.entries(STRATEGY_MAP).map(([key, def]) => ({
    id: key,
    name: def.name,
  }));
}

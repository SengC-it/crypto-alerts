// Strategy: RSI Reversal v2
// Inspired by Freqtrade RSI strategy and Jesse AI Mean Reversion

/**
 * RSI 反转策略 v2
 * 灵感来源: Freqtrade RSI + Jesse AI Mean Reversion
 * 
 * v2 优化（基于回测数据）:
 * 1. 提高中间区域置信度（35-40 和 60-65 不再被过滤）
 * 2. 结合 MACD 方向确认提高置信度
 * 3. RSI<25 或 RSI>75 给予额外置信度加成
 */
export function rsiReversal(params, indicators) {
  const { oversold = 35, overbought = 65, rsi_period = 14 } = params;
  const rsiKey = `rsi_${rsi_period}`;
  const rsiVal = indicators[rsiKey];

  if (rsiVal === null || rsiVal === undefined) return null;

  let signal = 'HOLD';
  let confidence = 0;
  let score = 0;
  let reason = '';

  if (rsiVal < oversold) {
    signal = 'BUY';
    // RSI越低置信度越高, 基础50起
    score = Math.min(50 + ((oversold - rsiVal) / oversold * 45), 95);
    confidence = Math.round(score);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (低于 ${oversold} 超卖区域)`;
  } else if (rsiVal > overbought) {
    signal = 'SELL';
    score = Math.min(50 + ((rsiVal - overbought) / (100 - overbought) * 45), 95);
    confidence = Math.round(score);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (高于 ${overbought} 超买区域)`;
  } else if (rsiVal < 40) {
    // RSI 在 35-40 之间，偏弱但未超卖
    signal = 'BUY';
    // 提高置信度到50-65区间，不再被minConfidence=50过滤
    score = Math.min(50 + ((40 - rsiVal) / (40 - oversold) * 15), 65);
    confidence = Math.round(score);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (偏弱区域，潜在反弹)`;
  } else if (rsiVal > 60) {
    // RSI 在 60-65 之间，偏强但未超买
    signal = 'SELL';
    score = Math.min(50 + ((rsiVal - 60) / (overbought - 60) * 15), 65);
    confidence = Math.round(score);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (偏强区域，潜在回调)`;
  }

  if (signal === 'HOLD') return null;

  // MACD 方向确认加成: 如果 RSI 信号方向与 MACD 一致，提升置信度
  if (indicators.macd) {
    const macdBullish = indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal;
    const macdBearish = indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal;
    if (signal === 'BUY' && macdBullish) {
      score = Math.min(score + 10, 95);
      confidence = Math.round(score);
      reason += ' +MACD确认';
    } else if (signal === 'SELL' && macdBearish) {
      score = Math.min(score + 10, 95);
      confidence = Math.round(score);
      reason += ' +MACD确认';
    }
  }

  const currentPrice = indicators.currentPrice;
  const atrVal = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'rsi_reversal',
    name: 'RSI 反转策略',
    signal,
    confidence,
    score: +score.toFixed(1),
    reason,
    indicators: { rsi: rsiVal.toFixed(2) },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atrVal * 1.5 : currentPrice + atrVal * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atrVal * 3 : currentPrice - atrVal * 3,
    riskRewardRatio: 2,
  };
}

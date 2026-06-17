// Strategy: RSI Reversal
// Inspired by Freqtrade RSI strategy and Jesse AI Mean Reversion

/**
 * RSI 反转策略 - RSI超卖买入, 超买卖出
 * 灵感来源: Freqtrade RSI + Jesse AI Mean Reversion
 * 
 * 优化: 扩展中性区间到 40-60，放宽超卖/超买阈值，增加回调确认
 */
export function rsiReversal(params, indicators) {
  const { oversold = 35, overbought = 65, rsi_period = 14 } = params;
  const rsiKey = `rsi_${rsi_period}`;
  const rsiVal = indicators[rsiKey];

  if (rsiVal === null || rsiVal === undefined) return null;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (rsiVal < oversold) {
    signal = 'BUY';
    confidence = Math.round((oversold - rsiVal) / oversold * 100);
    confidence = Math.min(confidence, 95);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (低于 ${oversold} 超卖区域)`;
  } else if (rsiVal > overbought) {
    signal = 'SELL';
    confidence = Math.round((rsiVal - overbought) / (100 - overbought) * 100);
    confidence = Math.min(confidence, 95);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (高于 ${overbought} 超买区域)`;
  } else if (rsiVal < 40) {
    // RSI 在 35-40 之间，偏弱但未超卖——低置信度 BUY
    signal = 'BUY';
    confidence = Math.round((40 - rsiVal) / (40 - oversold) * 40);
    confidence = Math.min(confidence, 40);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (偏弱区域，潜在反弹)`;
  } else if (rsiVal > 60) {
    // RSI 在 60-65 之间，偏强但未超买——低置信度 SELL
    signal = 'SELL';
    confidence = Math.round((rsiVal - 60) / (overbought - 60) * 40);
    confidence = Math.min(confidence, 40);
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (偏强区域，潜在回调)`;
  }

  if (signal === 'HOLD') return null;

  const currentPrice = indicators.currentPrice;
  const atrVal = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'rsi_reversal',
    name: 'RSI 反转策略',
    signal,
    confidence,
    reason,
    indicators: { rsi: rsiVal.toFixed(2) },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atrVal * 1.5 : currentPrice + atrVal * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atrVal * 3 : currentPrice - atrVal * 3,
    riskRewardRatio: '1:2',
  };
}

// Strategy: RSI Reversal
// Inspired by Freqtrade RSI strategy and Jesse AI Mean Reversion

/**
 * RSI 反转策略 - RSI超卖买入, 超买卖出
 * 灵感来源: Freqtrade RSI + Jesse AI Mean Reversion
 */
export function rsiReversal(params, indicators) {
  const { oversold = 30, overbought = 70, rsi_period = 14 } = params;
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
  } else if (rsiVal > 45 && rsiVal < 55) {
    reason = `RSI(${rsi_period}) = ${rsiVal.toFixed(2)} (中性区域)`;
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

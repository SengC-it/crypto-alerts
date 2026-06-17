// Strategy: Bollinger Band Mean Reversion
// Inspired by Freqtrade Bollinger strategy

/**
 * 布林带均值回归策略
 * 灵感来源: Freqtrade Bollinger Bands
 */
export function bollingerMeanReversion(params, indicators) {
  const bb = indicators.bollinger;

  if (bb === null) return null;

  const currentPrice = indicators.currentPrice;
  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (currentPrice <= bb.lower) {
    signal = 'BUY';
    confidence = Math.round((1 - bb.percentB) * 100);
    confidence = Math.min(confidence, 95);
    reason = `价格 ($${currentPrice.toFixed(2)}) 触及布林带下轨 ($${bb.lower.toFixed(2)}), %B=${bb.percentB.toFixed(2)}`;
  } else if (currentPrice >= bb.upper) {
    signal = 'SELL';
    confidence = Math.round(bb.percentB * 100);
    confidence = Math.min(confidence, 95);
    reason = `价格 ($${currentPrice.toFixed(2)}) 触及布林带上轨 ($${bb.upper.toFixed(2)}), %B=${bb.percentB.toFixed(2)}`;
  } else if (bb.bandwidth < 0.01) {
    reason = `布林带收窄 (带宽=${(bb.bandwidth * 100).toFixed(2)}%), 可能即将突破`;
  } else {
    reason = `价格在布林带内运行 (%B=${bb.percentB.toFixed(2)})`;
  }

  if (signal === 'HOLD') return null;

  const atr = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'bollinger_mean_reversion',
    name: '布林带均值回归策略',
    signal,
    confidence,
    reason,
    indicators: {
      upper: bb.upper.toFixed(2),
      middle: bb.middle.toFixed(2),
      lower: bb.lower.toFixed(2),
      percentB: bb.percentB.toFixed(2),
      bandwidth: (bb.bandwidth * 100).toFixed(2) + '%',
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: '1:2',
  };
}

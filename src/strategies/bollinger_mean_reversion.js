// Strategy: Bollinger Band Mean Reversion
// Inspired by Freqtrade Bollinger strategy

/**
 * 布林带均值回归策略
 * 灵感来源: Freqtrade Bollinger Bands
 * 
 * 优化: 使用 %B 阈值而非要求价格精确触轨
 *   %B < 0.10 视为接近下轨 (BUY)
 *   %B > 0.90 视为接近上轨 (SELL)
 */
export function bollingerMeanReversion(params, indicators) {
  const bb = indicators.bollinger;

  if (bb === null) return null;

  const currentPrice = indicators.currentPrice;
  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  // 价格触及或接近下轨
  if (bb.percentB <= 0.10) {
    signal = 'BUY';
    confidence = Math.round((0.10 - bb.percentB) / 0.10 * 100);
    confidence = Math.min(Math.max(confidence, 30), 95);
    reason = `价格接近布林带下轨 (%B=${bb.percentB.toFixed(2)}, 下轨=$${bb.lower.toFixed(2)})`;
  }
  // 价格触及或接近上轨
  else if (bb.percentB >= 0.90) {
    signal = 'SELL';
    confidence = Math.round((bb.percentB - 0.90) / 0.10 * 100);
    confidence = Math.min(Math.max(confidence, 30), 95);
    reason = `价格接近布林带上轨 (%B=${bb.percentB.toFixed(2)}, 上轨=$${bb.upper.toFixed(2)})`;
  }
  // 布林带收窄预告 - 返回低置信度 HOLD 信号供通知
  else if (bb.bandwidth < 0.03) {
    signal = 'HOLD';
    confidence = 20;
    reason = `布林带收窄 (带宽=${(bb.bandwidth * 100).toFixed(2)}%), 可能即将突破`;
  }

  // HOLD 信号不作为交易信号返回，但带宽收窄值得关注
  if (signal === 'HOLD') {
    if (bb.bandwidth < 0.03) {
      // 返回低置信度预警信号（不触发开仓，仅提醒）
      return {
        strategy: 'bollinger_mean_reversion',
        name: '布林带均值回归策略 (收敛预警)',
        signal: 'HOLD',
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
        stopLoss: 0,
        targetPrice: 0,
        riskRewardRatio: 0,
      };
    }
    return null;
  }

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
    riskRewardRatio: 2,
  };
}

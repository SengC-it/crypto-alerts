// Strategy: MACD Crossover
// Inspired by Freqtrade MACD strategy

/**
 * MACD 金叉/死叉策略
 * 灵感来源: Freqtrade MACD
 */
export function macdCross(params, indicators) {
  const macdData = indicators.macd;

  if (macdData === null) return null;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (macdData.histogram > 0 && macdData.macd > macdData.signal) {
    signal = 'BUY';
    confidence = Math.round(Math.min(Math.abs(macdData.histogram) / (Math.abs(macdData.macd) || 1), 1) * 100);
    confidence = Math.min(confidence, 90);
    reason = `MACD 金叉 - MACD=${macdData.macd.toFixed(4)} > Signal=${macdData.signal.toFixed(4)}, 柱状图=${macdData.histogram.toFixed(4)}`;
  } else if (macdData.histogram < 0 && macdData.macd < macdData.signal) {
    signal = 'SELL';
    confidence = Math.round(Math.min(Math.abs(macdData.histogram) / (Math.abs(macdData.macd) || 1), 1) * 100);
    confidence = Math.min(confidence, 90);
    reason = `MACD 死叉 - MACD=${macdData.macd.toFixed(4)} < Signal=${macdData.signal.toFixed(4)}, 柱状图=${macdData.histogram.toFixed(4)}`;
  } else {
    reason = `MACD 无交叉 - MACD=${macdData.macd.toFixed(4)}, Signal=${macdData.signal.toFixed(4)}`;
  }

  if (signal === 'HOLD') return null;

  const currentPrice = indicators.currentPrice;
  const atr = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'macd_cross',
    name: 'MACD 交叉策略',
    signal,
    confidence,
    reason,
    indicators: {
      macd: macdData.macd.toFixed(4),
      signal: macdData.signal.toFixed(4),
      histogram: macdData.histogram.toFixed(4),
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: 2,
  };
}

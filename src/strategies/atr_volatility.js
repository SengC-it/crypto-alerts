// Strategy: ATR Volatility Strategy
// Inspired by Jesse AI ATR Trailing Stop

/**
 * ATR 波动率策略
 * 当波动率突然放大时顺势入场
 * 灵感来源: Jesse ATR Trailing Stop
 */
export function atrVolatility(params, indicators) {
  const { period = 14, atr_multiplier = 2 } = params;
  const atr = indicators.atr_14;

  if (atr === null) return null;

  const currentPrice = indicators.currentPrice;
  const atrRatio = atr / currentPrice;  // ATR占价格比例
  const currentVolume = indicators.currentVolume;
  const volMA = indicators.volume_ma_20;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  // 波动率突然放大 (> 2倍正常水平)
  const isHighVolatility = atrRatio > atr_multiplier * 0.01;

  if (isHighVolatility) {
    // 结合价格方向和成交量
    const volumeRatio = volMA ? currentVolume / volMA : 1;
    const isHighVolume = volumeRatio > 1.5;

    if (currentPrice > indicators.sma_20 && isHighVolume) {
      signal = 'BUY';
      confidence = Math.round(Math.min(atrRatio * 1000, 85));
      reason = `波动率放大 + 放量上涨 - ATR比率=${(atrRatio * 100).toFixed(2)}%, 成交量=${(volumeRatio * 100).toFixed(0)}%均量`;
    } else if (currentPrice < indicators.sma_20 && isHighVolume) {
      signal = 'SELL';
      confidence = Math.round(Math.min(atrRatio * 1000, 85));
      reason = `波动率放大 + 放量下跌 - ATR比率=${(atrRatio * 100).toFixed(2)}%, 成交量=${(volumeRatio * 100).toFixed(0)}%均量`;
    } else {
      reason = `波动率放大但成交量不足 - ATR比率=${(atrRatio * 100).toFixed(2)}%`;
    }
  } else {
    reason = `波动率正常 - ATR比率=${(atrRatio * 100).toFixed(2)}%`;
  }

  if (signal === 'HOLD') return null;

  return {
    strategy: 'atr_volatility',
    name: 'ATR波动率策略',
    signal,
    confidence,
    reason,
    indicators: {
      atr: atr.toFixed(2),
      atr_ratio: (atrRatio * 100).toFixed(2) + '%',
      volume_ratio: volMA ? (currentVolume / volMA * 100).toFixed(0) + '%' : 'N/A',
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: '1:2',
  };
}

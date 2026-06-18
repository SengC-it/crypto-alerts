// Strategy: ATR Volatility Strategy
// Inspired by Jesse AI ATR Trailing Stop

/**
 * ATR 波动率策略
 * 当波动率突然放大时顺势入场
 * 灵感来源: Jesse ATR Trailing Stop
 * 
 * 优化: ATR阈值从2%降到1.5%，成交量要求从1.5x降到1.2x
 *   增加无放量时的低置信度信号（波动率放大即可）
 */
export function atrVolatility(params, indicators) {
  const { period = 14, atr_multiplier = 1.5 } = params;
  const atr = indicators.atr_14;

  if (atr === null || atr === undefined) return null;

  const currentPrice = indicators.currentPrice;
  const atrRatio = atr / currentPrice;  // ATR占价格比例
  const currentVolume = indicators.currentVolume;
  const volMA = indicators.volume_ma_20;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  // 波动率放大 (> 1.5% of price)
  const isHighVolatility = atrRatio > atr_multiplier * 0.01;

  if (isHighVolatility) {
    const volumeRatio = volMA ? currentVolume / volMA : 1;
    const isHighVolume = volumeRatio > 1.2;

    if (currentPrice > indicators.sma_20 && isHighVolume) {
      // 放量上涨 → 高置信度 BUY
      signal = 'BUY';
      confidence = Math.round(Math.min(atrRatio * 1000, 85));
      confidence = Math.max(confidence, 60);
      reason = `波动率放大 + 放量上涨 - ATR比率=${(atrRatio * 100).toFixed(2)}%, 成交量=${(volumeRatio * 100).toFixed(0)}%均量`;
    } else if (currentPrice > indicators.sma_20) {
      // 上涨但量不够 → 低置信度 BUY
      signal = 'BUY';
      confidence = Math.round(Math.min(atrRatio * 800, 55));
      confidence = Math.max(confidence, 30);
      reason = `波动率放大 + 上涨(量不足) - ATR比率=${(atrRatio * 100).toFixed(2)}%`;
    } else if (currentPrice < indicators.sma_20 && isHighVolume) {
      // 放量下跌 → 高置信度 SELL
      signal = 'SELL';
      confidence = Math.round(Math.min(atrRatio * 1000, 85));
      confidence = Math.max(confidence, 60);
      reason = `波动率放大 + 放量下跌 - ATR比率=${(atrRatio * 100).toFixed(2)}%, 成交量=${(volumeRatio * 100).toFixed(0)}%均量`;
    } else if (currentPrice < indicators.sma_20) {
      // 下跌但量不够 → 低置信度 SELL
      signal = 'SELL';
      confidence = Math.round(Math.min(atrRatio * 800, 55));
      confidence = Math.max(confidence, 30);
      reason = `波动率放大 + 下跌(量不足) - ATR比率=${(atrRatio * 100).toFixed(2)}%`;
    }
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
    riskRewardRatio: 2,
  };
}

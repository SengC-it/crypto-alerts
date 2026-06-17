// Strategy: Volume Confirmation
// Inspired by Freqtrade volume-based strategies

/**
 * 成交量确认策略
 * 放量突破 + 指标确认才触发
 * 灵感来源: Freqtrade Volume
 */
export function volumeConfirmation(params, indicators) {
  const { volume_ma_period = 20, volume_multiplier = 1.5 } = params;
  const volMA = indicators['volume_ma_' + volume_ma_period];

  if (volMA === null) return null;

  const currentPrice = indicators.currentPrice;
  const currentVolume = indicators.currentVolume;
  const volumeRatio = currentVolume / volMA;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (volumeRatio >= volume_multiplier) {
    // 放量 - 检查价格方向
    const sma20 = indicators.sma_20;
    const rsi = indicators.rsi_14;

    if (currentPrice > sma20 && rsi > 50 && rsi < 70) {
      signal = 'BUY';
      confidence = Math.round(Math.min(volumeRatio * 20, 90));
      reason = `放量上涨确认 - 成交量=${(volumeRatio * 100).toFixed(0)}%均量, RSI=${rsi ? rsi.toFixed(2) : 'N/A'}, 价格在SMA20上方`;
    } else if (currentPrice < sma20 && rsi > 30 && rsi < 50) {
      signal = 'SELL';
      confidence = Math.round(Math.min(volumeRatio * 20, 90));
      reason = `放量下跌确认 - 成交量=${(volumeRatio * 100).toFixed(0)}%均量, RSI=${rsi ? rsi.toFixed(2) : 'N/A'}, 价格在SMA20下方`;
    } else {
      reason = `放量但方向不明确 - 成交量=${(volumeRatio * 100).toFixed(0)}%均量`;
    }
  } else {
    reason = `成交量正常 - 当前=${(currentVolume / 1000000).toFixed(2)}M, 均量=${(volMA / 1000000).toFixed(2)}M, 比率=${(volumeRatio * 100).toFixed(0)}%`;
  }

  if (signal === 'HOLD') return null;

  const atr = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'volume_confirmation',
    name: '成交量确认策略',
    signal,
    confidence,
    reason,
    indicators: {
      volume_ratio: (volumeRatio * 100).toFixed(0) + '%',
      current_volume: currentVolume.toFixed(0),
      avg_volume: volMA.toFixed(0),
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: '1:2',
  };
}

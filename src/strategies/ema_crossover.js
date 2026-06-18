// Strategy: EMA Crossover
// Inspired by Freqtrade EMA strategy

/**
 * EMA 双均线交叉策略
 * 灵感来源: Freqtrade Custom Stoploss / ROI
 */
export function emaCrossover(params, indicators) {
  const { fast = 9, slow = 21 } = params;
  const fastEma = indicators['ema_' + fast];
  const slowEma = indicators['ema_' + slow];

  if (fastEma === null || slowEma === null) return null;

  const currentPrice = indicators.currentPrice;
  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  const priceAbove = currentPrice > slowEma;
  const fastAboveSlow = fastEma > slowEma;

  if (priceAbove && fastAboveSlow) {
    reason = `EMA${fast} ($${fastEma.toFixed(2)}) > EMA${slow} ($${slowEma.toFixed(2)}), 价格在上方 - 多头排列`;
    if (fastEma - slowEma < currentPrice * 0.005) {
      signal = 'BUY';
      confidence = 75;
      reason = `EMA${fast}/${slow} 金叉附近 - ${reason}`;
    }
  } else if (!priceAbove && !fastAboveSlow) {
    reason = `EMA${fast} ($${fastEma.toFixed(2)}) < EMA${slow} ($${slowEma.toFixed(2)}), 价格在下方 - 空头排列`;
    if (slowEma - fastEma < currentPrice * 0.005) {
      signal = 'SELL';
      confidence = 75;
      reason = `EMA${fast}/${slow} 死叉附近 - ${reason}`;
    }
  } else {
    reason = `均线交叉确认中 - 价格${priceAbove ? '上方' : '下方'}均线`;
  }

  if (signal === 'HOLD') return null;

  const atr = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'ema_crossover',
    name: 'EMA 双均线交叉策略',
    signal,
    confidence,
    reason,
    indicators: {
      ['ema_' + fast]: fastEma.toFixed(2),
      ['ema_' + slow]: slowEma.toFixed(2),
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: 2,
  };
}

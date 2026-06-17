// Strategy: Donchian Channel Breakout
// Inspired by Jesse AI Donchian strategy / Turtle Trading

/**
 * 唐奇安通道突破策略
 * 灵感来源: Jesse AI Donchian / Turtle Trading
 */
export function donchianBreakout(params, indicators) {
  const dc = indicators.donchian;

  if (dc === null) return null;

  const currentPrice = indicators.currentPrice;
  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (currentPrice >= dc.upper) {
    signal = 'BUY';
    confidence = 80;
    reason = `价格突破唐奇安通道上轨 ($${dc.upper.toFixed(2)}) - N日新高`;
  } else if (currentPrice <= dc.lower) {
    signal = 'SELL';
    confidence = 80;
    reason = `价格跌破唐奇安通道下轨 ($${dc.lower.toFixed(2)}) - N日新低`;
  } else if (currentPrice > dc.middle) {
    reason = '价格在唐奇安通道中上部运行';
  } else {
    reason = '价格在唐奇安通道中下部运行';
  }

  if (signal === 'HOLD') return null;

  const atr = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'donchian_breakout',
    name: '唐奇安通道突破策略',
    signal,
    confidence,
    reason,
    indicators: {
      upper: dc.upper.toFixed(2),
      middle: dc.middle.toFixed(2),
      lower: dc.lower.toFixed(2),
      period: params.period,
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: '1:2',
  };
}

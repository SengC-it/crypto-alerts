// Strategy: Donchian Channel Breakout
// Inspired by Jesse AI Donchian strategy / Turtle Trading

/**
 * 唐奇安通道突破策略
 * 灵感来源: Jesse AI Donchian / Turtle Trading
 * 
 * 优化: 使用通道位置百分比而非精确触轨
 *   价格在通道上方 90% 区域视为接近突破 (BUY)
 *   价格在通道下方 10% 区域视为接近跌破 (SELL)
 *   完全突破仍给最高置信度
 */
export function donchianBreakout(params, indicators) {
  const dc = indicators.donchian;

  if (dc === null) return null;

  const currentPrice = indicators.currentPrice;
  const channelWidth = dc.upper - dc.lower;

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  // 计算价格在通道中的位置 (0 = 下轨, 1 = 上轨)
  const channelPosition = channelWidth > 0 ? (currentPrice - dc.lower) / channelWidth : 0.5;

  if (currentPrice >= dc.upper) {
    // 完全突破上轨
    signal = 'BUY';
    confidence = 80;
    reason = `价格突破唐奇安通道上轨 ($${dc.upper.toFixed(2)}) - N日新高`;
  } else if (currentPrice <= dc.lower) {
    // 完全跌破下轨
    signal = 'SELL';
    confidence = 80;
    reason = `价格跌破唐奇安通道下轨 ($${dc.lower.toFixed(2)}) - N日新低`;
  } else if (channelPosition >= 0.90) {
    // 接近上轨突破
    signal = 'BUY';
    confidence = Math.round((channelPosition - 0.90) / 0.10 * 50 + 30);
    confidence = Math.min(confidence, 70);
    reason = `价格接近唐奇安通道上轨 (位置=${(channelPosition * 100).toFixed(0)}%, 上轨=$${dc.upper.toFixed(2)})`;
  } else if (channelPosition <= 0.10) {
    // 接近下轨跌破
    signal = 'SELL';
    confidence = Math.round((0.10 - channelPosition) / 0.10 * 50 + 30);
    confidence = Math.min(confidence, 70);
    reason = `价格接近唐奇安通道下轨 (位置=${(channelPosition * 100).toFixed(0)}%, 下轨=$${dc.lower.toFixed(2)})`;
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

// Strategy: Multi-Indicator Resonance
// Inspired by Jesse AI multi-timeframe analysis

/**
 * 多指标共振策略
 * 当至少 N 个指标同时发出相同信号时才触发
 * 灵感来源: Jesse AI 多时间框架分析
 */
export function multiIndicatorResonance(params, indicators) {
  const { required_indicators = 2 } = params;

  if (indicators.rsi_14 === null || indicators.macd === null || indicators.bollinger === null) {
    return null;
  }

  const currentPrice = indicators.currentPrice;
  const buyVotes = [];
  const sellVotes = [];

  // RSI 投票
  if (indicators.rsi_14 < 30) buyVotes.push('RSI超卖');
  if (indicators.rsi_14 > 70) sellVotes.push('RSI超买');

  // MACD 投票
  if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) {
    buyVotes.push('MACD金叉');
  }
  if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
    sellVotes.push('MACD死叉');
  }

  // 布林带投票
  if (currentPrice <= indicators.bollinger.lower) buyVotes.push('布林下轨');
  if (currentPrice >= indicators.bollinger.upper) sellVotes.push('布林上轨');

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (buyVotes.length >= required_indicators) {
    signal = 'BUY';
    confidence = Math.round((buyVotes.length / 3) * 100);
    reason = `多指标共振买入 - ${buyVotes.join(', ')}`;
  } else if (sellVotes.length >= required_indicators) {
    signal = 'SELL';
    confidence = Math.round((sellVotes.length / 3) * 100);
    reason = `多指标共振卖出 - ${sellVotes.join(', ')}`;
  } else {
    reason = `指标未共振 - 买入票:${buyVotes.length}, 卖出票:${sellVotes.length} (需要${required_indicators}票)`;
  }

  if (signal === 'HOLD') return null;

  const atr = indicators.atr_14 || currentPrice * 0.02;

  return {
    strategy: 'multi_indicator_resonance',
    name: '多指标共振策略',
    signal,
    confidence,
    reason,
    indicators: {
      buy_votes: buyVotes.join(', ') || '无',
      sell_votes: sellVotes.join(', ') || '无',
      rsi_14: indicators.rsi_14.toFixed(2),
      macd_histogram: indicators.macd.histogram.toFixed(4),
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: '1:2',
  };
}

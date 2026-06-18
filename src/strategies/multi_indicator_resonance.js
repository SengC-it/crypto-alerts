// Strategy: Multi-Indicator Resonance v2
// Inspired by Jesse AI multi-timeframe analysis
// v2: 扩展投票指标到6个，降低RSI阈值增加参与度，增加EMA趋势和成交量投票

/**
 * 多指标共振策略 v2
 * 当至少 N 个指标同时发出相同信号时才触发
 * 
 * v2 改进（基于回测数据）:
 * 1. RSI 阈值从 30/70 放宽到 35/65，与 rsi_reversal 策略对齐
 * 2. 增加 EMA 趋势投票（EMA9 > EMA21 = 看多）
 * 3. 增加成交量投票（放量 = 确认当前方向）
 * 4. 布林带 %B 替代精确触轨（更宽松）
 * 5. 置信度基于投票占比，最低要求2票
 * 6. 总投票池从3个扩展到6个，共振更可靠
 */
export function multiIndicatorResonance(params, indicators) {
  const { required_indicators = 2 } = params;

  if (indicators.rsi_14 === null || indicators.macd === null || indicators.bollinger === null) {
    return null;
  }

  const currentPrice = indicators.currentPrice;
  const buyVotes = [];
  const sellVotes = [];
  const totalVoters = 6; // 6个投票指标

  // 1. RSI 投票 (阈值对齐 rsi_reversal: 35/65)
  if (indicators.rsi_14 < 35) buyVotes.push('RSI偏弱');
  else if (indicators.rsi_14 > 65) sellVotes.push('RSI偏强');

  // 2. MACD 投票
  if (indicators.macd.histogram > 0 && indicators.macd.macd > indicators.macd.signal) {
    buyVotes.push('MACD金叉');
  }
  if (indicators.macd.histogram < 0 && indicators.macd.macd < indicators.macd.signal) {
    sellVotes.push('MACD死叉');
  }

  // 3. 布林带投票 (%B 替代精确触轨)
  const bb = indicators.bollinger;
  if (bb) {
    if (bb.percentB <= 0.15) buyVotes.push('BB偏下轨');
    else if (bb.percentB >= 0.85) sellVotes.push('BB偏上轨');
  }

  // 4. EMA 趋势投票
  if (indicators.ema_9 != null && indicators.ema_21 != null) {
    if (indicators.ema_9 > indicators.ema_21 && currentPrice > indicators.ema_9) {
      buyVotes.push('EMA多头');
    } else if (indicators.ema_9 < indicators.ema_21 && currentPrice < indicators.ema_9) {
      sellVotes.push('EMA空头');
    }
  }

  // 5. 成交量确认投票
  const volMA = indicators.volume_ma_20;
  const currentVol = indicators.currentVolume;
  if (volMA && currentVol) {
    const volRatio = currentVol / volMA;
    if (volRatio > 1.3) {
      // 放量确认当前价格方向
      if (currentPrice > indicators.sma_20) {
        buyVotes.push('放量上涨');
      } else if (currentPrice < indicators.sma_20) {
        sellVotes.push('放量下跌');
      }
    }
  }

  // 6. 价格相对SMA位置投票（趋势确认）
  if (indicators.sma_50 != null) {
    if (currentPrice > indicators.sma_50 * 1.01) {
      buyVotes.push('价格>SMA50');
    } else if (currentPrice < indicators.sma_50 * 0.99) {
      sellVotes.push('价格<SMA50');
    }
  }

  let signal = 'HOLD';
  let confidence = 0;
  let reason = '';

  if (buyVotes.length >= required_indicators && buyVotes.length > sellVotes.length) {
    signal = 'BUY';
    // 置信度: 2票=40%, 3票=55%, 4票=70%, 5票=85%, 6票=95%
    confidence = Math.round(25 + (buyVotes.length - 1) * 14);
    confidence = Math.min(confidence, 95);
    reason = `多指标共振买入(${buyVotes.length}/${totalVoters}) - ${buyVotes.join(', ')}`;
  } else if (sellVotes.length >= required_indicators && sellVotes.length > buyVotes.length) {
    signal = 'SELL';
    confidence = Math.round(25 + (sellVotes.length - 1) * 14);
    confidence = Math.min(confidence, 95);
    reason = `多指标共振卖出(${sellVotes.length}/${totalVoters}) - ${sellVotes.join(', ')}`;
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
      bb_percentB: bb ? bb.percentB.toFixed(2) : 'N/A',
    },
    suggestedEntry: currentPrice,
    stopLoss: signal === 'BUY' ? currentPrice - atr * 1.5 : currentPrice + atr * 1.5,
    targetPrice: signal === 'BUY' ? currentPrice + atr * 3 : currentPrice - atr * 3,
    riskRewardRatio: 2,
  };
}

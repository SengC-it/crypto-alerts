// 历史回测引擎 v2
// 拉取 Binance 历史 K 线数据，逐根模拟策略运行
// 支持三档冷却期、信号冷却模拟、详细交易分析

import { CONFIG } from '../config.js';
import { loadBacktestHistory } from './history.js';
import { SignalEngine } from '../signal/engine.js';
import { SignalEvaluator } from '../evaluation/signalEvaluator.js';
import { candleToIso, normalizeCandles } from '../market/candle.js';
import { computeAllIndicators } from '../indicators/index.js';

export function calculateNetTradePnl({
  direction,
  entryPrice,
  exitPrice,
  feeRatePercent = 0,
  slippagePercent = 0,
}) {
  const gross = direction === 'BUY'
    ? ((exitPrice - entryPrice) / entryPrice) * 100
    : ((entryPrice - exitPrice) / entryPrice) * 100;
  const cost = (feeRatePercent + slippagePercent) * 2;

  return {
    grossPnlPercent: +gross.toFixed(4),
    roundTripCostPercent: +cost.toFixed(4),
    netPnlPercent: +(gross - cost).toFixed(4),
  };
}

/**
 * 单笔交易记录
 */
class Trade {
  constructor(entrySignal, entryTime, entryIndex) {
    this.signal = entrySignal;
    this.entryIndex = entryIndex;
    this.symbol = entrySignal.symbol;
    this.strategy = entrySignal.strategy;
    this.direction = entrySignal.signal;
    this.entryPrice = entrySignal.suggestedEntry;
    this.stopLoss = entrySignal.stopLoss;
    this.targetPrice = entrySignal.targetPrice;
    this.confidence = entrySignal.confidence;
    this.entryTime = entryTime;
    this.exitPrice = null;
    this.exitTime = null;
    this.exitReason = null;
    this.grossPnlPercent = 0;
    this.pnlPercent = 0;
    this.costPercent = 0;
    this.holdHours = 0;
  }

  close(price, time, reason, costPercent = 0) {
    this.exitPrice = price;
    this.exitTime = time;
    this.exitReason = reason;
    this.holdHours = (time - this.entryTime) / (1000 * 60 * 60);
    this.costPercent = costPercent;

    if (this.direction === 'BUY') {
      this.grossPnlPercent = ((price - this.entryPrice) / this.entryPrice) * 100;
    } else {
      this.grossPnlPercent = ((this.entryPrice - price) / this.entryPrice) * 100;
    }
    this.pnlPercent = this.grossPnlPercent - costPercent;
  }
}

/**
 * 获取币种所属档位
 */
function getTier(symbol, config = CONFIG) {
  for (const [key, tier] of Object.entries(config.MONITOR_TIERS || {})) {
    if (tier.symbols?.includes(symbol)) return { key, ...tier };
  }
  return { key: 'unknown', name: '未知', cooldownMinutes: 240, intervalMinutes: 60 };
}

export function evaluateBacktestCandle({
  symbol,
  timeframe = '1h',
  candles,
  config = CONFIG,
  signalEngine,
  indicators = null,
  now,
  strategyOverrides,
  minConfidence,
  filterConflicts,
  boostResonance,
  buyRequiresTrendConfirm,
  profitFilter,
  roundTripCostPercent,
  generatedAt,
} = {}) {
  const engine = signalEngine || new SignalEngine({ config });
  return engine.evaluate({
    symbol,
    timeframe,
    candles,
    indicators,
    now,
    strategyOverrides,
    minConfidence,
    filterConflicts,
    boostResonance,
    buyRequiresTrendConfirm,
    profitFilter,
    roundTripCostPercent,
    generatedAt,
  });
}

function applyAccountRiskParameters(signal, indicators, stopLossATR, takeProfitATR) {
  const entry = Number(signal?.suggestedEntry ?? signal?.entry_reference);
  const atr = Number(indicators?.atr_14);
  if (!Number.isFinite(entry) || !Number.isFinite(atr) || atr <= 0) return signal;

  const isBuy = signal.signal === 'BUY';
  return {
    ...signal,
    suggestedEntry: entry,
    stopLoss: isBuy ? entry - atr * stopLossATR : entry + atr * stopLossATR,
    targetPrice: isBuy ? entry + atr * takeProfitATR : entry - atr * takeProfitATR,
    riskRewardRatio: +(takeProfitATR / stopLossATR).toFixed(6),
  };
}

/**
 * 对单个交易对执行回测
 */
export async function backtestSymbol(symbol, days = 30, options = {}) {
  const config = options.config || CONFIG;
  const {
    minConfidence,
    noConflictFilter = true,
    usePosition = true,
    leverage = 1,
    initialCapital = 10000,
    boostResonance = true,
    // 风控参数（可覆盖）
    stopLossATR = 1.5,          // 止损距离 = N * ATR
    takeProfitATR = 3.0,        // 止盈距离 = N * ATR
    trailingStop = false,        // 是否启用移动止损
    trailingATR = 1.0,          // 移动止损回撤 = N * ATR
    positionTimeoutHours = 48,   // 持仓超时
    roundTripCostPercent = config.TRADING_COSTS?.roundTripPercent ?? 0,
    profitFilter = config.PROFIT_FILTER,
    candles: injectedCandles = null,
    indicatorSeries = null,
    computeIndicatorsFn = computeAllIndicators,
  } = options;

  const tier = getTier(symbol, config);
  const cooldownMs = (options.cooldownMinutes ?? tier.cooldownMinutes) * 60 * 1000;
  const effectiveMinConf = minConfidence ?? config.SIGNAL_FILTER?.minConfidence ?? 30;
  const warmup = options.warmup ?? 100;

  // The older optimized scan API supplied a complete synthetic candle array
  // with indicatorSeries but no asOf. Keep that fixture contract while all
  // normal backtests use the strict requested-window coverage gate.
  const legacyFixture = Boolean(
    indicatorSeries
    && injectedCandles
    && options.asOf === undefined,
  );
  const history = legacyFixture
    ? {
        candles: normalizeCandles(injectedCandles, {
          symbol,
          timeframe: '1h',
          now: Date.now(),
        }),
        coverage: null,
      }
    : await loadBacktestHistory(symbol, days, {
        ...options,
        candles: options.candles || options.candlesBySymbol?.[symbol],
        timeframe: '1h',
        warmup,
        strictCoverage: options.strictCoverage,
        asOf: options.asOf,
      });
  const allCandles = history.candles;
  if (!Array.isArray(allCandles) || allCandles.length <= warmup) {
    throw new Error('Insufficient historical data after warmup');
  }

  // Legacy indicatorSeries remains supported; new optimizer callers should
  // pass indicatorsBySymbol so every path shares this same evaluator.
  const indicatorSource = options.indicatorsBySymbol?.[symbol] ?? indicatorSeries;
  const signalEngine = new SignalEngine({ config });
  const indicatorAt = (index, candleSlice) => {
    if (indicatorSource) {
      if (typeof indicatorSource === 'function') {
        return indicatorSource({ index, candles: candleSlice, symbol });
      }
      if (Array.isArray(indicatorSource)) {
        return indicatorSource[index] || null;
      }
      if (indicatorSource[index] && typeof indicatorSource[index] === 'object') {
        return indicatorSource[index];
      }
      const timestamp = candleSlice.at(-1)?.open_time;
      return indicatorSource[timestamp] || indicatorSource;
    }
    return computeIndicatorsFn(candleSlice);
  };
  const evaluateAt = (index, candleSlice, currentTime) => evaluateBacktestCandle({
    symbol,
    timeframe: '1h',
    candles: candleSlice,
    config,
    signalEngine,
    indicators: indicatorAt(index, candleSlice),
    now: currentTime,
    strategyOverrides: options.strategyOverrides,
    minConfidence: effectiveMinConf,
    filterConflicts: noConflictFilter,
    boostResonance,
    buyRequiresTrendConfirm: config.SIGNAL_FILTER?.buyRequiresTrendConfirm !== false,
    profitFilter,
    roundTripCostPercent,
    generatedAt: candleToIso(currentTime),
  });

  // 3. 逐根K线回测
  const trades = [];
  const evaluatedSignals = [];
  let rawSignalCount = 0;
  let filteredSignalCount = 0;
  let openTrade = null;
  const signalCooldowns = new Map();   // signal cooldown tracking
  let highestEquity = initialCapital;
  let peak = initialCapital;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;
  let equity = initialCapital;
  // 移动止损跟踪
  let trailHigh = 0;  // 持仓期间最高价 (BUY) 或最低价 (SELL)

  for (let i = warmup; i < allCandles.length; i++) {
    const currentTime = allCandles[i].close_time ?? allCandles[i].timestamp ?? allCandles[i].open_time;
    const currentPrice = allCandles[i].close;
    const currentHigh = allCandles[i].high;
    const currentLow = allCandles[i].low;
    const candleSlice = allCandles.slice(0, i + 1);
    const evaluation = evaluateAt(i, candleSlice, currentTime);
    const filteredSignals = evaluation.signals || [];
    rawSignalCount += evaluation.rawSignals?.length || 0;
    filteredSignalCount += filteredSignals.length;
    for (const signal of filteredSignals) {
      evaluatedSignals.push({ signal, signalIndex: i });
    }

    // 3a. 检查持仓
    if (openTrade) {
      const hoursInPosition = (currentTime - openTrade.entryTime) / (1000 * 60 * 60);

      // 更新移动止损跟踪
      if (trailingStop) {
        if (openTrade.direction === 'BUY') {
          if (currentHigh > trailHigh) trailHigh = currentHigh;
          const trailStop = trailHigh - (openTrade.stopLoss - openTrade.entryPrice + (openTrade.entryPrice - openTrade.stopLoss) * (trailingATR / stopLossATR));
          // 简化: trailStop = trailHigh - atr * trailingATR，用原始止损距离估算
          const atrEstimate = Math.abs(openTrade.entryPrice - openTrade.stopLoss) / stopLossATR;
          const dynamicStop = trailHigh - atrEstimate * trailingATR;
          if (dynamicStop > openTrade.stopLoss) {
            openTrade.stopLoss = dynamicStop;
          }
        } else {
          if (currentLow < trailHigh || trailHigh === 0) trailHigh = currentLow;
          const atrEstimate = Math.abs(openTrade.stopLoss - openTrade.entryPrice) / stopLossATR;
          const dynamicStop = trailHigh + atrEstimate * trailingATR;
          if (dynamicStop < openTrade.stopLoss) {
            openTrade.stopLoss = dynamicStop;
          }
        }
      }

      // 止损
      if (openTrade.direction === 'BUY' && currentLow <= openTrade.stopLoss) {
        openTrade.close(openTrade.stopLoss, currentTime, 'stop_loss', roundTripCostPercent);
        const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
        equity += pnl;
        if (equity > peak) peak = equity;
        const ddPct = ((peak - equity) / peak) * 100;
        if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
        trades.push(openTrade);
        openTrade = null;
        continue;
      }
      if (openTrade.direction === 'SELL' && currentHigh >= openTrade.stopLoss) {
        openTrade.close(openTrade.stopLoss, currentTime, 'stop_loss', roundTripCostPercent);
        const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
        equity += pnl;
        if (equity > peak) peak = equity;
        const ddPct = ((peak - equity) / peak) * 100;
        if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
        trades.push(openTrade);
        openTrade = null;
        continue;
      }

      // 止盈
      if (openTrade.direction === 'BUY' && currentHigh >= openTrade.targetPrice) {
        openTrade.close(openTrade.targetPrice, currentTime, 'target', roundTripCostPercent);
        const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
        equity += pnl;
        if (equity > peak) peak = equity;
        const ddPct = ((peak - equity) / peak) * 100;
        if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
        trades.push(openTrade);
        openTrade = null;
        continue;
      }
      if (openTrade.direction === 'SELL' && currentLow <= openTrade.targetPrice) {
        openTrade.close(openTrade.targetPrice, currentTime, 'target', roundTripCostPercent);
        const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
        equity += pnl;
        if (equity > peak) peak = equity;
        const ddPct = ((peak - equity) / peak) * 100;
        if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
        trades.push(openTrade);
        openTrade = null;
        continue;
      }

      // 超时平仓
      if (hoursInPosition >= positionTimeoutHours) {
        openTrade.close(currentPrice, currentTime, 'timeout', roundTripCostPercent);
        const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
        equity += pnl;
        if (equity > peak) peak = equity;
        const ddPct = ((peak - equity) / peak) * 100;
        if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
        trades.push(openTrade);
        openTrade = null;
        continue;
      }

      // Existing positions also use the shared SignalEngine for reversal checks.
      if (filteredSignals.length > 0) {
        const oppositeSignals = filteredSignals.filter(s =>
          (openTrade.direction === 'BUY' && s.signal === 'SELL') ||
          (openTrade.direction === 'SELL' && s.signal === 'BUY')
        );
        if (oppositeSignals.length > 0) {
          // 只在反向信号置信度 >= 当前持仓置信度时才平仓
          const best = oppositeSignals.reduce((a, b) => a.confidence > b.confidence ? a : b);
          if (best.confidence >= openTrade.confidence * 0.8) {
            openTrade.close(currentPrice, currentTime, 'opposite_signal', roundTripCostPercent);
            const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
            equity += pnl;
            if (equity > peak) peak = equity;
            const ddPct = ((peak - equity) / peak) * 100;
            if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
            trades.push(openTrade);
            openTrade = null;
          }
        }
      }

      if (usePosition && openTrade) continue;
    }

    // No position — check new signals through the shared SignalEngine.
    if (filteredSignals.length === 0) continue;

    // 3d. 信号冷却检查
    const bestSignal = filteredSignals.reduce((a, b) => a.confidence > b.confidence ? a : b);
    const cooldownKey = `${symbol}:${bestSignal.strategy}:${bestSignal.signal}`;
    const lastSignalTime = signalCooldowns.get(cooldownKey);
    if (lastSignalTime && (currentTime - lastSignalTime) < cooldownMs) {
      continue; // 冷却期内跳过
    }

    // 开仓
    const tradeSignal = applyAccountRiskParameters(
      bestSignal,
      evaluation.indicators,
      stopLossATR,
      takeProfitATR,
    );
    openTrade = new Trade(tradeSignal, currentTime, i);
    trailHigh = openTrade.direction === 'BUY' ? currentHigh : currentLow;
    signalCooldowns.set(cooldownKey, currentTime);
  }

  // 收盘未平仓
  if (openTrade) {
    const lastPrice = allCandles[allCandles.length - 1].close;
    const lastTime = allCandles[allCandles.length - 1].close_time
      ?? allCandles[allCandles.length - 1].timestamp
      ?? allCandles[allCandles.length - 1].open_time;
    openTrade.close(lastPrice, lastTime, 'end_of_backtest', roundTripCostPercent);
    const pnl = equity * (openTrade.pnlPercent / 100) * leverage;
    equity += pnl;
    if (equity > peak) peak = equity;
    const ddPct = ((peak - equity) / peak) * 100;
    if (ddPct > maxDrawdownPercent) { maxDrawdownPercent = ddPct; maxDrawdown = peak - equity; }
    trades.push(openTrade);
  }

  // Keep signal-level forward evaluation separate from account simulation.
  const signalEvaluator = new SignalEvaluator({ roundTripCostPercent });
  const signalEvaluations = evaluatedSignals.map(item => signalEvaluator.evaluate(
    item.signal,
    allCandles,
    { signalIndex: item.signalIndex },
  ));

  // 5. 计算统计数据
  return calculateStats(
    symbol,
    trades,
    initialCapital,
    leverage,
    days,
    allCandles.length - warmup,
    tier,
    maxDrawdown,
    maxDrawdownPercent,
    equity,
    history.coverage,
    signalEvaluations,
    rawSignalCount,
    filteredSignalCount,
  );
}

/**
 * 计算回测统计数据
 */
function calculateStats(symbol, trades, initialCapital, leverage, days, totalHours, tier, maxDD, maxDDPct, finalEquity, coverage, signalEvaluations, rawSignalCount, filteredSignalCount) {
  if (trades.length === 0) {
    return {
      symbol,
      tier: tier.key,
      days,
      totalTrades: 0,
      rawSignalCount,
      filteredSignalCount,
      coverage,
      signalEvaluations,
      message: 'No trades generated',
    };
  }

  const wins = trades.filter(t => t.pnlPercent > 0);
  const losses = trades.filter(t => t.pnlPercent <= 0);
  const bigWins = trades.filter(t => t.pnlPercent > 3);   // 大赚
  const bigLosses = trades.filter(t => t.pnlPercent < -2); // 大亏

  // 按策略统计
  const byStrategy = {};
  for (const t of trades) {
    if (!byStrategy[t.strategy]) {
      byStrategy[t.strategy] = { wins: 0, losses: 0, totalPnl: 0, trades: 0, avgHold: 0, totalHold: 0 };
    }
    byStrategy[t.strategy].trades++;
    if (t.pnlPercent > 0) byStrategy[t.strategy].wins++;
    else byStrategy[t.strategy].losses++;
    byStrategy[t.strategy].totalPnl += t.pnlPercent;
    byStrategy[t.strategy].totalHold += t.holdHours;
  }
  for (const s of Object.values(byStrategy)) {
    s.avgHold = s.trades > 0 ? (s.totalHold / s.trades).toFixed(1) : '0';
    delete s.totalHold;
  }

  // 按平仓原因统计
  const byExitReason = {};
  for (const t of trades) {
    byExitReason[t.exitReason] = (byExitReason[t.exitReason] || 0) + 1;
  }

  // 按方向统计
  const byDirection = { BUY: { count: 0, wins: 0, pnl: 0 }, SELL: { count: 0, wins: 0, pnl: 0 } };
  for (const t of trades) {
    byDirection[t.direction].count++;
    if (t.pnlPercent > 0) byDirection[t.direction].wins++;
    byDirection[t.direction].pnl += t.pnlPercent;
  }

  // 连胜/连亏
  let maxConsecWins = 0, maxConsecLosses = 0, currWins = 0, currLosses = 0;
  for (const t of trades) {
    if (t.pnlPercent > 0) { currWins++; currLosses = 0; maxConsecWins = Math.max(maxConsecWins, currWins); }
    else { currLosses++; currWins = 0; maxConsecLosses = Math.max(maxConsecLosses, currLosses); }
  }

  // 夏普比率 (简化: 用每笔交易盈亏的均值/标准差 * sqrt(365*24/avgHoldHours))
  const pnlArr = trades.map(t => t.pnlPercent);
  const avgPnl = pnlArr.reduce((s, v) => s + v, 0) / pnlArr.length;
  const stdPnl = Math.sqrt(pnlArr.reduce((s, v) => s + (v - avgPnl) ** 2, 0) / pnlArr.length);
  const avgHoldH = pnlArr.length > 0 ? trades.reduce((s, t) => s + t.holdHours, 0) / trades.length : 1;
  const tradesPerYear = (365 * 24) / Math.max(avgHoldH, 1);
  const sharpeRatio = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(tradesPerYear) : 0;

  const totalPnlPercent = ((finalEquity - initialCapital) / initialCapital) * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) : 0;
  const profitFactor = losses.length > 0 && losses.reduce((s, t) => s + t.pnlPercent, 0) !== 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnlPercent, 0) / losses.reduce((s, t) => s + t.pnlPercent, 0))
    : wins.length > 0 ? Infinity : 0;

  // 所有交易明细（供详细分析用）
  const allTradeDetails = trades.map(t => ({
    direction: t.direction,
    strategy: t.strategy,
    entry: +t.entryPrice.toFixed(4),
    exit: t.exitPrice ? +t.exitPrice.toFixed(4) : null,
    stopLoss: +t.stopLoss.toFixed(4),
    target: +t.targetPrice.toFixed(4),
    exitReason: t.exitReason,
    grossPnl: +t.grossPnlPercent.toFixed(2),
    cost: +t.costPercent.toFixed(2),
    pnl: +t.pnlPercent.toFixed(2),
    confidence: t.confidence,
    signalTimestamp: t.signal?.signal_timestamp || null,
    holdHours: +t.holdHours.toFixed(1),
  }));

  return {
    symbol,
    tier: tier.key,
    days,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    bigWins: bigWins.length,
    bigLosses: bigLosses.length,
    winRate: +((wins.length / trades.length) * 100).toFixed(1),
    avgWinPnl: +avgWin.toFixed(2),
    avgLossPnl: +avgLoss.toFixed(2),
    profitFactor: profitFactor === Infinity ? 999 : +profitFactor.toFixed(2),
    totalPnlPercent: +totalPnlPercent.toFixed(2),
    finalEquity: +finalEquity.toFixed(2),
    maxDrawdown: +maxDD.toFixed(2),
    maxDrawdownPercent: +maxDDPct.toFixed(2),
    sharpeRatio: +sharpeRatio.toFixed(2),
    maxConsecWins,
    maxConsecLosses,
    avgHoldHours: +avgHoldH.toFixed(1),
    exitReasons: byExitReason,
    byStrategy,
    byDirection,
    trades: allTradeDetails,
    rawSignalCount,
    filteredSignalCount,
    coverage,
    signalEvaluations,
  };
}

/**
 * 全币种回测
 */
export async function backtestAll(days = 30, options = {}) {
  const config = options.config || CONFIG;
  const results = [];
  const errors = [];

  // 按档位分批，避免同时请求太多
  const symbols = options.tier
    ? config.MONITOR_TIERS[options.tier]?.symbols || config.BINANCE_SYMBOLS
    : config.BINANCE_SYMBOLS;

  // 分批处理，每批5个，避免API限流
  const BATCH_SIZE = 5;
  for (let i = 0; i < symbols.length; i += BATCH_SIZE) {
    const batch = symbols.slice(i, i + BATCH_SIZE);
    const tasks = batch.map(async (symbol) => {
      try {
        const result = await backtestSymbol(symbol, days, options);
        return { ok: true, result };
      } catch (err) {
        return { ok: false, symbol, error: err.message, coverage: err.coverage };
      }
    });

    const settled = await Promise.allSettled(tasks);
    for (const item of settled) {
      if (item.status === 'fulfilled') {
        const val = item.value;
        if (val.ok && !val.result.error) {
          results.push(val.result);
        } else {
          errors.push(val.result || val);
        }
      } else {
        errors.push({
          error: item.reason?.message || 'Unknown error',
          coverage: item.reason?.coverage,
        });
      }
    }
  }

  if (options.strictCoverage !== false && errors.length > 0) {
    const details = errors.map(error => {
      const coverage = error?.coverage;
      const coverageDetail = coverage
        ? ` coverage=${coverage.candles_loaded}/${coverage.candles_expected}`
        : '';
      return `${error?.symbol || 'unknown'}: ${error?.error || 'backtest failed'}${coverageDetail}`;
    }).join('; ');
    const experimentError = new Error(`Backtest experiment failed closed: ${details}`);
    experimentError.errors = errors;
    throw experimentError;
  }

  // 按档位汇总
  const byTier = {};
  for (const r of results) {
    const t = r.tier || 'unknown';
    if (!byTier[t]) byTier[t] = { symbols: 0, totalTrades: 0, totalWins: 0, totalPnl: 0, totalDD: 0 };
    byTier[t].symbols++;
    byTier[t].totalTrades += r.totalTrades || 0;
    byTier[t].totalWins += r.wins || 0;
    byTier[t].totalPnl += r.totalPnlPercent || 0;
    byTier[t].totalDD += r.maxDrawdownPercent || 0;
  }

  // 全局策略统计
  const globalStrategy = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.byStrategy || {})) {
      if (!globalStrategy[k]) globalStrategy[k] = { wins: 0, losses: 0, totalPnl: 0, trades: 0 };
      globalStrategy[k].wins += v.wins;
      globalStrategy[k].losses += v.losses;
      globalStrategy[k].totalPnl += v.totalPnl;
      globalStrategy[k].trades += v.trades;
    }
  }

  // 全局方向统计
  const globalDirection = { BUY: { count: 0, wins: 0, pnl: 0 }, SELL: { count: 0, wins: 0, pnl: 0 } };
  for (const r of results) {
    for (const dir of ['BUY', 'SELL']) {
      if (r.byDirection?.[dir]) {
        globalDirection[dir].count += r.byDirection[dir].count;
        globalDirection[dir].wins += r.byDirection[dir].wins;
        globalDirection[dir].pnl += r.byDirection[dir].pnl;
      }
    }
  }

  // 全局平仓原因
  const globalExitReasons = {};
  for (const r of results) {
    for (const [reason, count] of Object.entries(r.exitReasons || {})) {
      globalExitReasons[reason] = (globalExitReasons[reason] || 0) + count;
    }
  }

  const totalTrades = results.reduce((s, r) => s + (r.totalTrades || 0), 0);
  const totalWins = results.reduce((s, r) => s + (r.wins || 0), 0);

  return {
    days,
    totalSymbols: results.length,
    totalTrades,
    avgWinRate: totalTrades > 0 ? +((totalWins / totalTrades) * 100).toFixed(1) : 0,
    globalStrategyStats: globalStrategy,
    globalDirection,
    globalExitReasons,
    byTier,
    results,
    errors,
  };
}

// 历史回测引擎
// 拉取 Binance 历史 K 线数据，逐根模拟策略运行，计算盈亏/回撤

import { CONFIG } from '../config.js';
import { getCandles } from '../websocket/rest.js';
import { computeAllIndicators } from '../indicators/index.js';
import { runStrategies, filterSignals } from '../strategies/manager.js';

/**
 * 单笔交易记录
 */
class Trade {
  constructor(entrySignal) {
    this.symbol = entrySignal.symbol;
    this.strategy = entrySignal.strategy;
    this.direction = entrySignal.signal;       // BUY / SELL
    this.entryPrice = entrySignal.suggestedEntry;
    this.stopLoss = entrySignal.stopLoss;
    this.targetPrice = entrySignal.targetPrice;
    this.confidence = entrySignal.confidence;
    this.entryTime = entrySignal.timestamp;
    this.exitPrice = null;
    this.exitTime = null;
    this.exitReason = null;  // 'stop_loss' | 'target' | 'timeout' | 'opposite_signal'
    this.pnlPercent = 0;
  }

  close(price, time, reason) {
    this.exitPrice = price;
    this.exitTime = time;
    this.exitReason = reason;

    if (this.direction === 'BUY') {
      this.pnlPercent = ((price - this.entryPrice) / this.entryPrice) * 100;
    } else {
      this.pnlPercent = ((this.entryPrice - price) / this.entryPrice) * 100;
    }
  }
}

/**
 * 对单个交易对执行回测
 * @param {string} symbol - 交易对
 * @param {number} days - 回测天数
 * @param {object} options - 回测选项
 */
export async function backtestSymbol(symbol, days = 30, options = {}) {
  const {
    minConfidence = 0,           // 最低置信度过滤
    noConflictFilter = true,     // 过滤矛盾信号（同币种同时买卖则跳过）
    usePosition = true,          // 是否模拟持仓（有持仓时不再开新仓）
    positionTimeout = 48,        // 持仓超时（小时），超时按当前价平仓
    leverage = 1,                // 杠杆倍数
    initialCapital = 10000,      // 初始资金
  } = options;

  // 1. 拉取历史K线（1h 级别，多拉一些用于指标计算）
  const totalCandles = days * 24 + 100;  // 额外100根用于指标预热
  const rawCandles = await getCandles(symbol, '1h', Math.min(totalCandles, 1500));

  if (!rawCandles || !Array.isArray(rawCandles) || rawCandles.length < 200) {
    return { symbol, error: 'Insufficient historical data', candlesLoaded: 0 };
  }

  const allCandles = rawCandles.map(c => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
    timestamp: c[6],
  }));

  // 2. 构建策略配置
  const strategyConfigs = {};
  for (const [key, defaults] of Object.entries(CONFIG.DEFAULT_STRATEGIES)) {
    if (!defaults.enabled) continue;
    strategyConfigs[key] = { enabled: true, params: { ...defaults } };
  }

  // 3. 逐根K线回测
  const trades = [];
  let openTrade = null;
  let positionOpenHour = 0;
  const warmup = 100;  // 前100根用于指标预热

  for (let i = warmup; i < allCandles.length; i++) {
    const currentTime = allCandles[i].timestamp;
    const currentPrice = allCandles[i].close;
    const currentHigh = allCandles[i].high;
    const currentLow = allCandles[i].low;
    const candleSlice = allCandles.slice(0, i + 1);

    // 3a. 检查持仓 - 止损/止盈/超时
    if (openTrade) {
      const hoursInPosition = (currentTime - openTrade.entryTime) / (1000 * 60 * 60);

      // 止损
      if (openTrade.direction === 'BUY' && currentLow <= openTrade.stopLoss) {
        openTrade.close(openTrade.stopLoss, currentTime, 'stop_loss');
        trades.push(openTrade);
        openTrade = null;
        continue;
      }
      if (openTrade.direction === 'SELL' && currentHigh >= openTrade.stopLoss) {
        openTrade.close(openTrade.stopLoss, currentTime, 'stop_loss');
        trades.push(openTrade);
        openTrade = null;
        continue;
      }

      // 止盈
      if (openTrade.direction === 'BUY' && currentHigh >= openTrade.targetPrice) {
        openTrade.close(openTrade.targetPrice, currentTime, 'target');
        trades.push(openTrade);
        openTrade = null;
        continue;
      }
      if (openTrade.direction === 'SELL' && currentLow <= openTrade.targetPrice) {
        openTrade.close(openTrade.targetPrice, currentTime, 'target');
        trades.push(openTrade);
        openTrade = null;
        continue;
      }

      // 超时平仓
      if (hoursInPosition >= positionTimeout) {
        openTrade.close(currentPrice, currentTime, 'timeout');
        trades.push(openTrade);
        openTrade = null;
        continue;
      }

      // 已经持仓，跳过新信号
      if (usePosition) continue;
    }

    // 3b. 计算指标 & 运行策略
    const indicators = computeAllIndicators(candleSlice);
    if (!indicators || indicators.currentPrice === undefined) continue;

    const rawSignals = runStrategies(symbol, indicators, strategyConfigs);
    
    // 3c. 信号质量过滤（置信度+矛盾+共振）
    const filterOptions = {
      minConfidence: options.minConfidence || CONFIG.SIGNAL_FILTER?.minConfidence || 30,
      filterConflicts: noConflictFilter,
      boostResonance: options.boostResonance !== false,
    };
    const filteredSignals = filterSignals(rawSignals, filterOptions);

    // 取置信度最高的信号
    if (filteredSignals.length === 0) continue;

    // 如果有持仓，检查是否出现反向信号
    if (openTrade) {
      const oppositeSignals = filteredSignals.filter(s =>
        (openTrade.direction === 'BUY' && s.signal === 'SELL') ||
        (openTrade.direction === 'SELL' && s.signal === 'BUY')
      );
      if (oppositeSignals.length > 0) {
        const best = oppositeSignals.reduce((a, b) => a.confidence > b.confidence ? a : b);
        openTrade.close(currentPrice, currentTime, 'opposite_signal');
        trades.push(openTrade);
        openTrade = null;
      }
      continue;
    }

    // 没有持仓，取最高置信度信号开仓
    const bestSignal = filteredSignals.reduce((a, b) => a.confidence > b.confidence ? a : b);
    openTrade = new Trade({ ...bestSignal, timestamp: currentTime });
    positionOpenHour = i;
  }

  // 收盘未平仓
  if (openTrade) {
    const lastPrice = allCandles[allCandles.length - 1].close;
    const lastTime = allCandles[allCandles.length - 1].timestamp;
    openTrade.close(lastPrice, lastTime, 'end_of_backtest');
    trades.push(openTrade);
  }

  // 4. 计算统计数据
  return calculateStats(symbol, trades, initialCapital, leverage, days, allCandles.length - warmup);
}

/**
 * 计算回测统计数据
 */
function calculateStats(symbol, trades, initialCapital, leverage, days, totalHours) {
  if (trades.length === 0) {
    return {
      symbol,
      days,
      totalTrades: 0,
      message: 'No trades generated',
    };
  }

  const wins = trades.filter(t => t.pnlPercent > 0);
  const losses = trades.filter(t => t.pnlPercent <= 0);

  // 按策略分统计
  const byStrategy = {};
  for (const t of trades) {
    if (!byStrategy[t.strategy]) {
      byStrategy[t.strategy] = { wins: 0, losses: 0, totalPnl: 0 };
    }
    if (t.pnlPercent > 0) byStrategy[t.strategy].wins++;
    else byStrategy[t.strategy].losses++;
    byStrategy[t.strategy].totalPnl += t.pnlPercent;
  }

  // 按平仓原因统计
  const byExitReason = {};
  for (const t of trades) {
    byExitReason[t.exitReason] = (byExitReason[t.exitReason] || 0) + 1;
  }

  // 累计收益曲线 & 最大回撤
  let equity = initialCapital;
  let peak = equity;
  let maxDrawdown = 0;
  let maxDrawdownPercent = 0;

  for (const t of trades) {
    const pnl = equity * (t.pnlPercent / 100) * leverage;
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    const ddPct = (dd / peak) * 100;
    if (ddPct > maxDrawdownPercent) {
      maxDrawdownPercent = ddPct;
      maxDrawdown = dd;
    }
  }

  const totalPnlPercent = ((equity - initialCapital) / initialCapital) * 100;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length) : 0;
  const profitFactor = losses.length > 0 && losses.reduce((s, t) => s + t.pnlPercent, 0) !== 0
    ? Math.abs(wins.reduce((s, t) => s + t.pnlPercent, 0) / losses.reduce((s, t) => s + t.pnlPercent, 0))
    : wins.length > 0 ? Infinity : 0;

  // 最近10笔交易明细
  const recentTrades = trades.slice(-10).map(t => ({
    direction: t.direction,
    strategy: t.strategy,
    entry: t.entryPrice.toFixed(2),
    exit: t.exitPrice?.toFixed(2),
    exitReason: t.exitReason,
    pnl: t.pnlPercent.toFixed(2) + '%',
    confidence: t.confidence,
  }));

  return {
    symbol,
    days,
    totalHours,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: ((wins.length / trades.length) * 100).toFixed(1) + '%',
    avgWinPnl: avgWin.toFixed(2) + '%',
    avgLossPnl: avgLoss.toFixed(2) + '%',
    profitFactor: profitFactor === Infinity ? '∞' : profitFactor.toFixed(2),
    totalPnlPercent: totalPnlPercent.toFixed(2) + '%',
    finalEquity: equity.toFixed(2),
    maxDrawdown: maxDrawdown.toFixed(2),
    maxDrawdownPercent: maxDrawdownPercent.toFixed(2) + '%',
    exitReasons: byExitReason,
    byStrategy,
    recentTrades,
  };
}

/**
 * 全币种回测
 */
export async function backtestAll(days = 30, options = {}) {
  const results = [];
  const errors = [];

  const tasks = CONFIG.BINANCE_SYMBOLS.map(async (symbol) => {
    try {
      const result = await backtestSymbol(symbol, days, options);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, symbol, error: err.message };
    }
  });

  const settled = await Promise.allSettled(tasks);

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      const val = item.value;
      if (val.ok && !val.result.error) {
        results.push(val.result);
      } else {
        errors.push(val.result || val.value);
      }
    } else {
      errors.push({ error: item.reason?.message || 'Unknown error' });
    }
  }

  // 汇总统计
  const totalTrades = results.reduce((s, r) => s + (r.totalTrades || 0), 0);
  const totalWins = results.reduce((s, r) => s + (r.wins || 0), 0);
  const avgWinRate = totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) + '%' : '0%';

  // 全局策略统计
  const globalStrategy = {};
  for (const r of results) {
    for (const [k, v] of Object.entries(r.byStrategy || {})) {
      if (!globalStrategy[k]) globalStrategy[k] = { wins: 0, losses: 0, totalPnl: 0 };
      globalStrategy[k].wins += v.wins;
      globalStrategy[k].losses += v.losses;
      globalStrategy[k].totalPnl += v.totalPnl;
    }
  }

  return {
    days,
    totalTrades,
    avgWinRate,
    globalStrategyStats: globalStrategy,
    results,
    errors,
  };
}

// Serverless-friendly signal checker
// 拉取 Binance REST 数据 → 计算指标 → 运行策略 → 去重 → 存储 + 发邮件
// 支持按档位 (tier) 检测不同币种

import { CONFIG, getIndicatorLookback } from '../../src/config.js';
import { getCandles } from '../../src/websocket/rest.js';
import { SignalEngine } from '../../src/signal/engine.js';
import { filterClosedCandles } from '../../src/market/candle.js';
import { signalStore } from '../../src/db/signalStore.js';
import { sendSignalEmail } from '../../src/email/notifier.js';
import { persistAndNotify } from '../../src/delivery.js';

const signalEngine = new SignalEngine({ config: CONFIG });

export function evaluateSymbolCandles(symbol, rawCandles, {
  config = CONFIG,
  engine,
  now = Date.now(),
  generatedAt = new Date(now).toISOString(),
} = {}) {
  const closedCandles = filterClosedCandles(rawCandles, {
    symbol,
    timeframe: '1h',
    now,
  });
  const indicatorLookbackCandles = getIndicatorLookback(config);
  const canonicalClosedCandles = closedCandles.length > indicatorLookbackCandles
    ? closedCandles.slice(-indicatorLookbackCandles)
    : closedCandles;
  const effectiveEngine = engine || (config === CONFIG
    ? signalEngine
    : new SignalEngine({ config }));

  return effectiveEngine.evaluate({
    symbol,
    timeframe: '1h',
    candles: canonicalClosedCandles,
    indicatorLookbackCandles,
    now,
    requireClosed: true,
    generatedAt,
  });
}

/**
 * 对单个交易对执行信号检测
 */
async function checkSymbol(symbol, {
  candleFetcher = getCandles,
  now = Date.now(),
  config = CONFIG,
} = {}) {
  const indicatorLookbackCandles = getIndicatorLookback(config);
  // REST can include the forming candle, so request a small margin above N.
  const rawCandles = await candleFetcher(symbol, '1h', indicatorLookbackCandles + 2);
  if (!Array.isArray(rawCandles)) {
    return { symbol, error: 'Invalid candle data', signalCount: 0 };
  }

  // REST usually includes the currently forming candle. Remove it before the
  // shared engine so the last closed candle remains eligible for evaluation.
  // The serverless path shares all signal logic with live and backtest.
  const evaluation = evaluateSymbolCandles(symbol, rawCandles, { now, config });
  if (!evaluation.eligible) {
    return {
      symbol,
      error: evaluation.reason,
      signalCount: 0,
      candlesLoaded: evaluation.candles?.length || 0,
    };
  }

  // Persist first, then transition delivery state around the send attempt.
  const results = [];
  for (const signal of evaluation.signals) {
    const isDup = await signalStore.isDuplicate(signal);
    if (isDup) {
      results.push({ ...signal, deduplicated: true });
      continue;
    }
    const delivery = await persistAndNotify({
      signal,
      signalStore,
      sendEmail: sendSignalEmail,
    });
    results.push({
      ...signal,
      deduplicated: false,
      emailSent: delivery.sent,
      deliveryStatus: delivery.record.delivery_status,
    });
  }

  return {
    symbol,
    price: evaluation.indicators.currentPrice,
    signalCount: evaluation.signals.length,
    newSignals: results.filter(s => !s.deduplicated).length,
    deduplicated: results.filter(s => s.deduplicated).length,
    signals: results,
  };
}

/**
 * 检测指定档位的所有交易对
 * @param {string} tierKey - 'tier1' | 'tier2' | 'tier3' | 'all'
 */
export async function checkTierSignals(tierKey = 'all') {
  let symbols = [];

  if (tierKey === 'all') {
    // 所有档位
    for (const tier of Object.values(CONFIG.MONITOR_TIERS)) {
      symbols.push(...tier.symbols);
    }
    symbols = [...new Set(symbols)];
  } else {
    const tier = CONFIG.MONITOR_TIERS[tierKey];
    if (!tier) {
      return { error: `Unknown tier: ${tierKey}`, availableTiers: Object.keys(CONFIG.MONITOR_TIERS) };
    }
    symbols = tier.symbols;
  }

  // 并行请求所有交易对
  const tasks = symbols.map(async (symbol) => {
    try {
      const result = await checkSymbol(symbol, { config: CONFIG });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, symbol, error: err.message };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const results = [];
  const errors = [];

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      const val = item.value;
      if (val.ok) {
        results.push(val.result);
        if (val.result.error) errors.push(val.result);
      } else {
        errors.push({ symbol: val.symbol, error: val.error });
      }
    } else {
      errors.push({ error: item.reason?.message || 'Unknown error' });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    tier: tierKey,
    totalChecked: results.length,
    totalErrors: errors.length,
    results,
  };
}

/**
 * 兼容旧接口 - 检测所有交易对
 */
export async function checkAllSignals() {
  return checkTierSignals('all');
}

export { checkSymbol };

// Serverless-friendly signal checker
// 拉取 Binance REST 数据 → 计算指标 → 运行策略 → 去重 → 存储 + 发邮件
// 支持按档位 (tier) 检测不同币种

import { CONFIG } from '../../src/config.js';
import { getCandles } from '../../src/websocket/rest.js';
import { computeAllIndicators } from '../../src/indicators/index.js';
import { runStrategies, filterSignals } from '../../src/strategies/manager.js';
import { signalStore } from '../../src/db/signalStore.js';
import { sendSummaryEmail } from '../../src/email/notifier.js';

/**
 * 对单个交易对执行信号检测
 * @param {boolean} skipEmail - 为 true 时只去重+存储，不发邮件（由上层统一发汇总）
 */
async function checkSymbol(symbol, skipEmail = true) {
  // 1. 拉取最近100根1小时K线
  let rawCandles;
  try {
    rawCandles = await getCandles(symbol, '1h', 100);
  } catch (fetchErr) {
    return { symbol, error: `Binance fetch error: ${fetchErr.message}`, signalCount: 0 };
  }

  if (!rawCandles || !Array.isArray(rawCandles)) {
    const type = typeof rawCandles;
    const preview = JSON.stringify(rawCandles).substring(0, 300);
    return { symbol, error: `Invalid candle data (type=${type}): ${preview}`, signalCount: 0 };
  }
  if (rawCandles.length < 50) {
    return { symbol, error: `Insufficient candle data: ${rawCandles.length} candles`, signalCount: 0 };
  }

  const candles = rawCandles.map(c => ({
    open: parseFloat(c[1]),
    high: parseFloat(c[2]),
    low: parseFloat(c[3]),
    close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
    timestamp: c[6],
  }));

  // 2. 计算所有技术指标
  const indicators = computeAllIndicators(candles);
  if (!indicators || indicators.currentPrice === undefined) {
    return { symbol, error: 'Indicator computation failed', signalCount: 0 };
  }

  // 3. 构建策略配置
  const strategyConfigs = {};
  for (const [key, defaults] of Object.entries(CONFIG.DEFAULT_STRATEGIES)) {
    if (!defaults.enabled) continue;
    strategyConfigs[key] = { enabled: true, params: { ...defaults } };
  }

  // 4. 运行策略
  const rawSignals = runStrategies(symbol, indicators, strategyConfigs);

  // 5. 信号质量过滤（置信度+矛盾+共振+趋势确认）
  const signals = filterSignals(rawSignals, {
    minConfidence: CONFIG.SIGNAL_FILTER?.minConfidence || 40,
    filterConflicts: CONFIG.SIGNAL_FILTER?.filterConflicts !== false,
    boostResonance: CONFIG.SIGNAL_FILTER?.boostResonance !== false,
    buyRequiresTrendConfirm: CONFIG.SIGNAL_FILTER?.buyRequiresTrendConfirm !== false,
    trendIndicators: { sma_50: indicators.sma_50, currentPrice: indicators.currentPrice, ema_9: indicators.ema_9, ema_21: indicators.ema_21 },
  });

  // 6. 去重 + 存储
  const results = [];
  for (const signal of signals) {
    const isDup = await signalStore.isDuplicate(signal);
    if (isDup) {
      results.push({ ...signal, deduplicated: true });
      continue;
    }
    await signalStore.save(signal);
    results.push({ ...signal, deduplicated: false });
  }

  return {
    symbol,
    price: indicators.currentPrice,
    signalCount: signals.length,
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
      const result = await checkSymbol(symbol);
      return { ok: true, result };
    } catch (err) {
      return { ok: false, symbol, error: err.message };
    }
  });

  const settled = await Promise.allSettled(tasks);
  const results = [];
  const errors = [];
  const newSignals = []; // 收集所有新信号（非去重）

  for (const item of settled) {
    if (item.status === 'fulfilled') {
      const val = item.value;
      if (val.ok) {
        results.push(val.result);
        if (val.result.error) errors.push(val.result);
        // 收集新信号
        for (const s of (val.result.signals || [])) {
          if (!s.deduplicated) newSignals.push(s);
        }
      } else {
        errors.push({ symbol: val.symbol, error: val.error });
      }
    } else {
      errors.push({ error: item.reason?.message || 'Unknown error' });
    }
  }

  // 汇总邮件：有新信号时才发，一封搞定
  let emailSent = false;
  if (newSignals.length > 0) {
    emailSent = await sendSummaryEmail(newSignals, tierKey);
  }

  return {
    timestamp: new Date().toISOString(),
    tier: tierKey,
    totalChecked: results.length,
    totalErrors: errors.length,
    newSignalCount: newSignals.length,
    emailSent,
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

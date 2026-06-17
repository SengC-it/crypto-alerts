// Serverless-friendly signal checker
// 拉取 Binance REST 数据 → 计算指标 → 运行策略 → 去重 → 存储 + 发邮件

import { CONFIG } from '../src/config.js';
import { getCandles } from '../src/websocket/rest.js';
import { computeAllIndicators } from '../src/indicators/index.js';
import { runStrategies } from '../src/strategies/manager.js';
import { signalStore } from '../src/db/signalStore.js';
import { sendSignalEmail } from '../src/email/notifier.js';

/**
 * 对单个交易对执行信号检测
 */
async function checkSymbol(symbol) {
  // 1. 拉取最近100根1小时K线
  const rawCandles = await getCandles(symbol, '1h', 100);
  if (!rawCandles || !Array.isArray(rawCandles) || rawCandles.length < 50) {
    return { symbol, error: 'Insufficient candle data', signalCount: 0 };
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
  const signals = runStrategies(symbol, indicators, strategyConfigs);

  // 5. 去重 + 存储 + 邮件
  const results = [];
  for (const signal of signals) {
    const isDup = await signalStore.isDuplicate(signal);
    if (isDup) {
      results.push({ ...signal, deduplicated: true });
      continue;
    }
    await signalStore.save(signal);
    const emailSent = await sendSignalEmail(signal);
    results.push({ ...signal, deduplicated: false, emailSent });
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
 * 检测所有交易对
 */
export async function checkAllSignals() {
  const results = [];
  const errors = [];

  for (const symbol of CONFIG.BINANCE.SYMBOLS) {
    try {
      const result = await checkSymbol(symbol);
      results.push(result);
      if (result.error) errors.push(result);
    } catch (err) {
      errors.push({ symbol, error: err.message });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    totalChecked: results.length,
    totalErrors: errors.length,
    results,
  };
}

export { checkSymbol };

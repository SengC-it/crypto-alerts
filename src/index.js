// Crypto Alerts - Main Entry
// 加密货币交易信号提醒系统

import { CONFIG } from './config.js';
import { wsClient } from './websocket/binance.js';
import { computeAllIndicators } from './indicators/index.js';
import { runStrategies, filterSignals, applyProfitFilter } from './strategies/manager.js';
import { signalStore } from './db/signalStore.js';
import { sendSignalEmail, sendStartupEmail, verifyEmailConfig } from './email/notifier.js';

const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLevel = LOG_LEVELS[CONFIG.LOG_LEVEL] ?? LOG_LEVELS.info;

function log(level, ...args) {
  if (LOG_LEVELS[level] <= currentLevel) {
    const ts = new Date().toISOString();
    console.log(`[${ts}] [${level.toUpperCase()}]`, ...args);
  }
}

/**
 * 处理K线收盘事件 - 核心分析流程
 */
async function onCandleClosed(symbol, candle, allCandles) {
  log('debug', `[${symbol}] Candle closed: close=${candle.close}`);

  // 1. 计算所有技术指标
  const indicators = computeAllIndicators(allCandles);
  if (!indicators || indicators.currentPrice === undefined) {
    log('warn', `[${symbol}] Insufficient data for indicators`);
    return;
  }

  // 2. 获取策略配置，传入策略运行器
  const strategyConfigs = {};
  for (const [key, defaults] of Object.entries(CONFIG.DEFAULT_STRATEGIES)) {
    if (!defaults.enabled) continue;
    strategyConfigs[key] = {
      enabled: true,
      params: { ...defaults },  // 包含 period, oversold 等参数
    };
  }

  // 3. 运行所有启用的策略
  const rawSignals = runStrategies(symbol, indicators, strategyConfigs);

  if (rawSignals.length === 0) {
    log('debug', `[${symbol}] No signals generated`);
    return;
  }

  // 3b. 信号质量过滤
  const qualitySignals = filterSignals(rawSignals, {
    minConfidence: CONFIG.SIGNAL_FILTER?.minConfidence || 40,
    filterConflicts: CONFIG.SIGNAL_FILTER?.filterConflicts !== false,
    boostResonance: CONFIG.SIGNAL_FILTER?.boostResonance !== false,
    buyRequiresTrendConfirm: CONFIG.SIGNAL_FILTER?.buyRequiresTrendConfirm !== false,
    trendIndicators: { sma_50: indicators.sma_50, currentPrice: indicators.currentPrice },
  });
  const signals = applyProfitFilter(qualitySignals, {
    ...CONFIG.PROFIT_FILTER,
    roundTripCostPercent: CONFIG.TRADING_COSTS.roundTripPercent,
  });

  if (signals.length === 0) {
    log('debug', `[${symbol}] All signals filtered out`);
    return;
  }

  // 4. 处理每个信号（去重 + 存储 + 通知）
  for (const signal of signals) {
    log('info', `[${signal.symbol}] ${signal.signal} signal from ${signal.name} (confidence: ${signal.confidence}%)`);

    // 去重检查
    const isDup = await signalStore.isDuplicate(signal);
    if (isDup) {
      log('info', `[${signal.symbol}] Signal deduplicated: ${signal.strategy}`);
      continue;
    }

    // 存储信号
    await signalStore.save(signal);

    // 发送邮件通知
    const sent = await sendSignalEmail(signal);
    if (sent) {
      log('info', `[${signal.symbol}] Email notification sent for ${signal.strategy}`);
    } else {
      log('warn', `[${signal.symbol}] Email notification failed for ${signal.strategy}`);
    }
  }
}

/**
 * 主启动函数
 */
async function main() {
  console.log('');
  console.log('╔══════════════════════════════════════════╗');
  console.log('║       Crypto Alerts - Signal Notifier    ║');
  console.log('╚══════════════════════════════════════════╝');
  console.log('');

  log('info', 'Monitoring tiers:');
  for (const [key, tier] of Object.entries(CONFIG.MONITOR_TIERS)) {
    log('info', `  ${key} (${tier.name}): ${tier.symbols.join(', ')} - every ${tier.intervalMinutes}min, cooldown ${tier.cooldownMinutes}min`);
  }
  log('info', 'Supabase:', CONFIG.SUPABASE.ENABLED ? 'ENABLED' : 'DISABLED (memory only)');
  log('info', 'Strategies enabled:', Object.entries(CONFIG.DEFAULT_STRATEGIES)
    .filter(([, v]) => v.enabled)
    .map(([k]) => k)
    .join(', '));

  // 1. 验证邮件配置
  log('info', 'Verifying email configuration...');
  const emailOk = await verifyEmailConfig();
  if (!emailOk) {
    log('warn', 'Email not configured - running in log-only mode');
  }

  // 2. 连接 WebSocket
  log('info', 'Connecting to Binance Futures WebSocket...');
  try {
    await wsClient.connect();
  } catch (err) {
    log('error', 'Failed to connect WebSocket:', err.message);
    log('info', 'Retrying in 10s...');
    await new Promise(r => setTimeout(r, 10000));
    try {
      await wsClient.connect();
    } catch (err2) {
      log('error', 'Second connection attempt failed:', err2.message);
      process.exit(1);
    }
  }

  // 3. 预热K线缓存
  log('info', 'Warming up candle cache...');
  await wsClient.warmUpCache();

  // 4. 注册 K线收盘监听器
  for (const symbol of CONFIG.BINANCE_SYMBOLS) {
    wsClient.onKline(symbol, (candle, allCandles) => {
      onCandleClosed(symbol, candle, allCandles).catch(err => {
        log('error', `[${symbol}] Error processing candle:`, err.message);
      });
    });
  }

  // 5. 发送启动通知邮件
  if (emailOk) {
    await sendStartupEmail(CONFIG.BINANCE_SYMBOLS);
  }

  log('info', '🚀 Crypto Alerts is running! Press Ctrl+C to stop.');
  console.log('');

  // 6. 优雅退出
  const shutdown = async () => {
    log('info', 'Shutting down...');
    wsClient.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// 启动
main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

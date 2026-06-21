// Environment Configuration Loader

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load env files manually (no dotenv dependency needed)
function loadEnv() {
  const envFiles = ['.env', 'ALL_PROXY.env'];
  for (const fileName of envFiles) {
    const envPath = path.join(__dirname, '..', fileName);
    if (!fs.existsSync(envPath)) continue;

    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (key && value && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

loadEnv();

export const CONFIG = {
  // Gmail SMTP
  GMAIL: {
    EMAIL: process.env.GMAIL_EMAIL || '',
    APP_PASSWORD: process.env.GMAIL_APP_PASSWORD || '',
    HOST: 'smtp.gmail.com',
    PORT: 587,
  },

  // 通知收件人（可以和发件人不同）
  NOTIFICATION_EMAIL: process.env.NOTIFICATION_EMAIL || process.env.GMAIL_EMAIL || '',

  // Supabase (optional)
  SUPABASE: {
    URL: process.env.SUPABASE_URL || '',
    KEY: process.env.SUPABASE_KEY || '',
    ENABLED: !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
  },

  // Binance WebSocket (public, no key needed)
  BINANCE: {
    WS_URL: 'wss://fstream.binance.com/ws',       // Futures
    REST_URL: 'https://fapi.binance.com',           // Futures REST API
  },

  // 三档监控体系 - 不同币种不同频率
  MONITOR_TIERS: {
    tier1: {
      name: '主流',
      symbols: (process.env.TIER1_PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT')
        .split(',').map(s => s.toUpperCase().trim()),
      intervalMinutes: 15,    // 15分钟检查一次
      cooldownMinutes: 30,    // 30分钟冷却（v5: 扣费PnL +9.5%, 风险收益比更优）
    },
    tier2: {
      name: '热门',
      symbols: (process.env.TIER2_PAIRS || 'XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,DOTUSDT,ARBUSDT,NEARUSDT,LTCUSDT,ATOMUSDT,UNIUSDT')
        .split(',').map(s => s.toUpperCase().trim()),
      intervalMinutes: 60,    // 1小时检查一次
      cooldownMinutes: 60,    // 1小时冷却（v5: 2h→1h, 扣费PnL +9.5%）
    },
    tier3: {
      name: '新锐',
      symbols: (process.env.TIER3_PAIRS || 'APTUSDT,STXUSDT,IMXUSDT,AAVEUSDT')
        .split(',').map(s => s.toUpperCase().trim()),
      intervalMinutes: 60,    // 1小时检查一次（v4: 从4h降至1h，STX/APT表现超预期+68%/+67%）
      cooldownMinutes: 120,   // 2小时冷却（v5: 4h→2h）
    },
  },

  // 兼容旧配置：SYMBOLS 汇总所有档位
  get BINANCE_SYMBOLS() {
    const all = [];
    for (const tier of Object.values(this.MONITOR_TIERS)) {
      all.push(...tier.symbols);
    }
    return [...new Set(all)];
  },

  // Log Level
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Default Strategy Config (optimized based on 30-coin 30-day backtest)
  DEFAULT_STRATEGIES: {
    rsi_reversal: {
      enabled: true,
      rsi_period: 14,
      oversold: 35,
      overbought: 65,
      timeframe: '1h',
    },
    macd_cross: {
      enabled: false,     // 回测表现差，禁用
      fast: 12,
      slow: 26,
      signal: 9,
      timeframe: '1h',
    },
    bollinger_mean_reversion: {
      enabled: true,
      period: 20,
      stdDev: 2,
      percentB_threshold: 0.10,
      timeframe: '1h',
    },
    ema_crossover: {
      enabled: false,     // 31.9%胜率, -30.1%盈亏，禁用
      fast: 9,
      slow: 21,
      timeframe: '1h',
    },
    multi_indicator_resonance: {
      enabled: true,
      required_indicators: 2,
      timeframe: '1h',
    },
    donchian_breakout: {
      enabled: false,    // v4: 禁用 — 胜率46.5%，PnL仅+6%，拖累整体
      period: 20,
      channel_position_threshold: 0.90,
      timeframe: '1h',
    },
    atr_volatility: {
      enabled: false,    // v4: 禁用 — 胜率49.4%，PnL仅+11%，拖累整体
      period: 14,
      atr_multiplier: 1.5,
      timeframe: '1h',
    },
    volume_confirmation: {
      enabled: true,
      volume_ma_period: 20,
      volume_multiplier: 1.3,
      timeframe: '1h',
    },
  },

  // 信号质量过滤配置（v4 优化 - 基于诊断回测数据）
  SIGNAL_FILTER: {
    minConfidence: 50,              // 降低到50%以不错过机会（回测显示50%比60%多15%收益）
    highPriorityConfidence: 75,     // 30/90/180d scans: use 75+ as high-priority action layer
    filterConflicts: true,
    boostResonance: true,
    buyRequiresTrendConfirm: true,  // 做多需要趋势确认（价格>SMA50）
    sellAlwaysAllowed: true,        // 做空不限（下跌市中做空更安全）
  },

  // 风控配置（v5 优化 - 基于全流程验证数据）
  RISK_MANAGEMENT: {
    trailingStop: true,             // 默认启用移动止损（回测: 812% vs 222%）
    trailingATR: 0.5,              // 30d optimization: best net PnL/score with fee-adjusted backtest
    stopLossATR: 1.5,              // 初始止损距离 = 1.5 * ATR
    takeProfitATR: 3.0,            // 止盈距离 = 3.0 * ATR（移动止损启用时较少触发）
    positionTimeoutHours: 48,      // 持仓超时（小时）
  },
};

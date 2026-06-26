// Environment Configuration Loader

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env file manually (no dotenv dependency needed)
function loadEnv() {
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const lines = fs.readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const [key, ...valueParts] = trimmed.split('=');
      const value = valueParts.join('=').trim();
      if (key && value) {
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
      cooldownMinutes: 120,   // 2小时冷却
    },
    tier2: {
      name: '热门',
      symbols: (process.env.TIER2_PAIRS || 'XRPUSDT,ADAUSDT,AVAXUSDT,LINKUSDT,DOTUSDT,ARBUSDT,NEARUSDT,LTCUSDT,ATOMUSDT,UNIUSDT')
        .split(',').map(s => s.toUpperCase().trim()),
      intervalMinutes: 60,    // 1小时检查一次
      cooldownMinutes: 240,   // 4小时冷却
    },
    tier3: {
      name: '新锐',
      symbols: (process.env.TIER3_PAIRS || 'APTUSDT,STXUSDT,IMXUSDT,AAVEUSDT')
        .split(',').map(s => s.toUpperCase().trim()),
      intervalMinutes: 240,   // 4小时检查一次
      cooldownMinutes: 480,   // 8小时冷却
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
      enabled: true,
      period: 20,
      channel_position_threshold: 0.90,
      timeframe: '1h',
    },
    atr_volatility: {
      enabled: true,
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

  // 信号质量过滤配置（v2 优化）
  SIGNAL_FILTER: {
    minConfidence: 60,              // 中频方案：60% 只通知高确定性信号
    filterConflicts: true,
    boostResonance: true,
    buyRequiresTrendConfirm: true,  // 做多需要趋势确认（价格>SMA50）
    sellAlwaysAllowed: true,        // 做空不限（下跌市中做空更安全）
  },
  TRADING_COSTS: {
    takerFeePercent: parseFloat(process.env.TAKER_FEE_PERCENT || '0.04'),
    slippagePercent: parseFloat(process.env.SLIPPAGE_PERCENT || '0.03'),
    get roundTripPercent() {
      return (this.takerFeePercent + this.slippagePercent) * 2;
    },
  },

  PROFIT_FILTER: {
    enabled: (process.env.PROFIT_FILTER_ENABLED || 'true').toLowerCase() !== 'false',
    allowDirections: (process.env.PROFIT_FILTER_DIRECTIONS || 'SELL')
      .split(',').map(s => s.toUpperCase().trim()).filter(Boolean),
    excludeStrategies: (process.env.PROFIT_FILTER_EXCLUDE_STRATEGIES || 'bollinger_mean_reversion')
      .split(',').map(s => s.trim()).filter(Boolean),
    minNetTargetPercent: parseFloat(process.env.PROFIT_FILTER_MIN_NET_TARGET_PERCENT || '1'),
  },
};

CONFIG.SIGNAL_FILTER.minConfidence = parseFloat(process.env.MIN_CONFIDENCE || '75');

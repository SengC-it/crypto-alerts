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

  // Supabase (optional)
  SUPABASE: {
    URL: process.env.SUPABASE_URL || '',
    KEY: process.env.SUPABASE_KEY || '',
    ENABLED: !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY),
  },

  // Binance WebSocket (public, no key needed)
  BINANCE: {
    WS_URL: 'wss://fstream.binance.com/ws',       // Futures (鍚堢害)
    REST_URL: 'https://fapi.binance.com',           // Futures REST API
    SYMBOLS: (process.env.MONITOR_PAIRS || 'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,XRPUSDT,ADAUSDT,DOTUSDT,LINKUSDT')
      .split(',')
      .map(s => s.toUpperCase()),
  },

  // Signal Cooldown (minutes)
  SIGNAL_COOLDOWN_MINUTES: parseInt(process.env.SIGNAL_COOLDOWN_MINUTES) || 240,

  // Log Level
  LOG_LEVEL: (process.env.LOG_LEVEL || 'info').toLowerCase(),

  // Default Strategy Config
  DEFAULT_STRATEGIES: {
    rsi_reversal: {
      enabled: true,
      rsi_period: 14,
      oversold: 30,
      overbought: 70,
      timeframe: '1h',
    },
    macd_cross: {
      enabled: true,
      fast: 12,
      slow: 26,
      signal: 9,
      timeframe: '1h',
    },
    bollinger_mean_reversion: {
      enabled: true,
      period: 20,
      stdDev: 2,
      timeframe: '1h',
    },
    ema_crossover: {
      enabled: true,
      fast: 9,
      slow: 21,
      timeframe: '1h',
    },
    multi_indicator_resonance: {
      enabled: true,
      required_indicators: 2,  // At least 2 of 3 must agree
      timeframe: '1h',
    },
    donchian_breakout: {
      enabled: true,
      period: 20,
      timeframe: '1h',
    },
    atr_volatility: {
      enabled: true,
      period: 14,
      atr_multiplier: 2,
      timeframe: '1h',
    },
    volume_confirmation: {
      enabled: true,
      volume_ma_period: 20,
      volume_multiplier: 1.5,
      timeframe: '1h',
    },
  },
};

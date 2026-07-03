-- Crypto Alerts - Supabase schema
-- Run this script in the Supabase SQL Editor.

-- ============================================================
-- 1. Signal records
-- ============================================================
CREATE TABLE IF NOT EXISTS crypto_signals (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key        TEXT NOT NULL,                -- "SYMBOL:STRATEGY:DIRECTION"
  symbol            TEXT NOT NULL,                -- BTCUSDT
  strategy          TEXT NOT NULL,                -- rsi_reversal
  signal_direction  TEXT NOT NULL CHECK (signal_direction IN ('BUY', 'SELL')),
  confidence        INTEGER NOT NULL DEFAULT 0,   -- 0-100 confidence
  score             DOUBLE PRECISION,             -- ranking score, falls back to confidence
  priority          TEXT NOT NULL DEFAULT 'low' CHECK (priority IN ('high', 'watch', 'low')),
  priority_label    TEXT,                         -- reader-facing priority label
  priority_action   TEXT NOT NULL DEFAULT 'ignore' CHECK (priority_action IN ('trade_candidate', 'watch_only', 'ignore')),
  reason            TEXT,
  suggested_entry   DOUBLE PRECISION,
  stop_loss         DOUBLE PRECISION,
  target_price      DOUBLE PRECISION,
  risk_reward_ratio TEXT,
  indicators        JSONB,
  email_sent_at     TIMESTAMPTZ,                  -- alert email send timestamp
  tracking_status   TEXT NOT NULL DEFAULT 'ignored' CHECK (tracking_status IN ('open', 'watch_only', 'closed', 'ignored')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe upgrades for existing projects created from older schema versions.
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'low' CHECK (priority IN ('high', 'watch', 'low'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS priority_label TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS priority_action TEXT NOT NULL DEFAULT 'ignore' CHECK (priority_action IN ('trade_candidate', 'watch_only', 'ignore'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'ignored' CHECK (tracking_status IN ('open', 'watch_only', 'closed', 'ignored'));

-- Dedupe lookup.
CREATE INDEX IF NOT EXISTS idx_signals_dedupe_time
  ON crypto_signals (dedupe_key, created_at DESC);

-- Recent signals by symbol.
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time
  ON crypto_signals (symbol, created_at DESC);

-- Recent signals globally.
CREATE INDEX IF NOT EXISTS idx_signals_created_at
  ON crypto_signals (created_at DESC);

-- Signal review and performance tracking.
CREATE INDEX IF NOT EXISTS idx_signals_priority_time
  ON crypto_signals (priority, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signals_tracking_status
  ON crypto_signals (tracking_status, created_at DESC);

-- ============================================================
-- 2. Row level security
-- ============================================================
ALTER TABLE crypto_signals ENABLE ROW LEVEL SECURITY;

-- Anonymous clients may read signals for dashboard/API display.
CREATE POLICY "Allow anonymous read access"
  ON crypto_signals FOR SELECT
  TO anon
  USING (true);

-- Service role may write and manage signals.
CREATE POLICY "Allow service role full access"
  ON crypto_signals FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 3. Cleanup helper
-- ============================================================
CREATE OR REPLACE FUNCTION clean_old_signals()
RETURNS void AS $$
BEGIN
  DELETE FROM crypto_signals WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Optional pg_cron schedule:
-- SELECT cron.schedule('clean-old-signals', '0 3 * * *', 'SELECT clean_old_signals()');

-- Verification:
-- SELECT * FROM crypto_signals LIMIT 5;

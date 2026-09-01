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
  direction         TEXT,
  raw_score         DOUBLE PRECISION,
  entry_reference   DOUBLE PRECISION,
  model_version     TEXT,
  commit_sha        TEXT,
  config_hash       TEXT,
  signal_engine_version TEXT,
  generated_at      TIMESTAMPTZ,
  signal_timestamp  TIMESTAMPTZ,
  candle_open_time  TIMESTAMPTZ,
  candle_close_time TIMESTAMPTZ,
  timeframe         TEXT,
  regime            TEXT,
  volatility_regime TEXT,
  raw_features      JSONB,
  contributing_evidence JSONB,
  rejected_evidence JSONB,
  filter_reasons    JSONB,
  signal_status     TEXT NOT NULL DEFAULT 'persisted',
  delivered_at      TIMESTAMPTZ,
  delivery_status   TEXT NOT NULL DEFAULT 'pending',
  delivery_error    TEXT,
  email_sent_at     TIMESTAMPTZ,                  -- alert email send timestamp
  take_profit_1     DOUBLE PRECISION,
  take_profit_2     DOUBLE PRECISION,
  take_profit_3     DOUBLE PRECISION,
  email_delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_delivery_status IN ('pending', 'sent', 'failed')),
  tracking_status   TEXT NOT NULL DEFAULT 'ignored' CHECK (tracking_status IN ('open', 'watch_only', 'closed', 'ignored')),
  review_status     TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'closed', 'invalid')),
  review_outcome    TEXT CHECK (review_outcome IN ('win', 'loss')),
  review_exit_price DOUBLE PRECISION,
  review_exit_time  TIMESTAMPTZ,
  review_exit_reason TEXT,
  review_trigger_level TEXT,
  review_gross_pnl_percent DOUBLE PRECISION,
  review_net_pnl_percent DOUBLE PRECISION,
  review_round_trip_cost_percent DOUBLE PRECISION,
  review_r_multiple DOUBLE PRECISION,
  review_hold_hours DOUBLE PRECISION,
  review_last_price DOUBLE PRECISION,
  review_unrealized_pnl_percent DOUBLE PRECISION,
  review_checked_at TIMESTAMPTZ,
  review_checked_until TIMESTAMPTZ,
  review_ambiguous_candle BOOLEAN NOT NULL DEFAULT FALSE,
  review_error      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Safe upgrades for existing projects created from older schema versions.
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS score DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'low' CHECK (priority IN ('high', 'watch', 'low'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS priority_label TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS priority_action TEXT NOT NULL DEFAULT 'ignore' CHECK (priority_action IN ('trade_candidate', 'watch_only', 'ignore'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS email_sent_at TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS tracking_status TEXT NOT NULL DEFAULT 'ignored' CHECK (tracking_status IN ('open', 'watch_only', 'closed', 'ignored'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS direction TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS raw_score DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS entry_reference DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS model_version TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS commit_sha TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS config_hash TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS signal_engine_version TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS signal_timestamp TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS candle_open_time TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS candle_close_time TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS timeframe TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS regime TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS volatility_regime TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS raw_features JSONB;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS contributing_evidence JSONB;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS rejected_evidence JSONB;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS filter_reasons JSONB;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS signal_status TEXT DEFAULT 'persisted';
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS delivery_status TEXT DEFAULT 'pending';
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS delivery_error TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS take_profit_1 DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS take_profit_2 DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS take_profit_3 DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_delivery_status IN ('pending', 'sent', 'failed'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'closed', 'invalid'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_outcome TEXT CHECK (review_outcome IN ('win', 'loss'));
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_exit_price DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_exit_time TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_exit_reason TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_trigger_level TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_gross_pnl_percent DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_net_pnl_percent DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_round_trip_cost_percent DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_r_multiple DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_hold_hours DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_last_price DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_unrealized_pnl_percent DOUBLE PRECISION;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_checked_at TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_checked_until TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_ambiguous_candle BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS review_error TEXT;

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

CREATE INDEX IF NOT EXISTS idx_signals_status
  ON crypto_signals (signal_status, delivery_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signals_email_delivery_status
  ON crypto_signals (email_delivery_status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_signals_review_status
  ON crypto_signals (review_status, created_at DESC);

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

-- Data API access requires both table grants and RLS policies.
REVOKE ALL PRIVILEGES ON TABLE public.crypto_signals FROM anon, authenticated, service_role;
GRANT SELECT ON TABLE public.crypto_signals TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.crypto_signals TO service_role;

DO $$
DECLARE
  signal_id_sequence TEXT;
BEGIN
  signal_id_sequence := pg_get_serial_sequence('public.crypto_signals', 'id');
  IF signal_id_sequence IS NOT NULL THEN
    EXECUTE format(
      'REVOKE ALL PRIVILEGES ON SEQUENCE %s FROM anon, authenticated, service_role',
      signal_id_sequence
    );
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO service_role',
      signal_id_sequence
    );
  END IF;
END;
$$;

-- Verification:
-- SELECT * FROM crypto_signals LIMIT 5;

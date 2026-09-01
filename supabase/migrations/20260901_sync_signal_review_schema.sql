-- Synchronize the repository bootstrap schema with additive review columns
-- already present in production. No existing row is updated or deleted.

ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS take_profit_1 DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS take_profit_2 DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS take_profit_3 DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS email_delivery_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_delivery_status IN ('pending', 'sent', 'failed'));
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_status TEXT NOT NULL DEFAULT 'open' CHECK (review_status IN ('open', 'closed', 'invalid'));
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_outcome TEXT CHECK (review_outcome IN ('win', 'loss'));
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_exit_price DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_exit_time TIMESTAMPTZ;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_exit_reason TEXT;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_trigger_level TEXT;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_gross_pnl_percent DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_net_pnl_percent DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_round_trip_cost_percent DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_r_multiple DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_hold_hours DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_last_price DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_unrealized_pnl_percent DOUBLE PRECISION;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_checked_at TIMESTAMPTZ;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_checked_until TIMESTAMPTZ;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_ambiguous_candle BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE public.crypto_signals ADD COLUMN IF NOT EXISTS review_error TEXT;

CREATE INDEX IF NOT EXISTS idx_signals_email_delivery_status
  ON public.crypto_signals (email_delivery_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_review_status
  ON public.crypto_signals (review_status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_priority_time
  ON public.crypto_signals (priority, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_signals_tracking_status
  ON public.crypto_signals (tracking_status, created_at DESC);

-- M0 signal lineage and delivery-state migration.
-- Additive only: no historical rows are deleted or rewritten destructively.

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
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS signal_status TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS delivery_status TEXT;
ALTER TABLE crypto_signals ADD COLUMN IF NOT EXISTS delivery_error TEXT;

CREATE INDEX IF NOT EXISTS idx_signals_status
  ON crypto_signals (signal_status, delivery_status, created_at DESC);

-- Supabase Data API access needs explicit grants in addition to RLS policies.
GRANT SELECT ON TABLE public.crypto_signals TO anon;
GRANT SELECT, INSERT, UPDATE ON TABLE public.crypto_signals TO service_role;

DO $$
DECLARE
  signal_id_sequence TEXT;
BEGIN
  signal_id_sequence := pg_get_serial_sequence('public.crypto_signals', 'id');
  IF signal_id_sequence IS NOT NULL THEN
    EXECUTE format(
      'GRANT USAGE, SELECT ON SEQUENCE %s TO service_role',
      signal_id_sequence
    );
  END IF;
END;
$$;

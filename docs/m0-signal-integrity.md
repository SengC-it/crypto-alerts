# M0 Signal Integrity Foundation

## Scope

M0 keeps the system as a signal notifier only. It does not place orders, open
positions, close positions, manage leverage, or use exchange private trading
APIs.

## One signal path

src/signal/engine.js is the shared entry point for:

- the WebSocket close event in src/index.js;
- the REST/Vercel checker in api/lib/checker.js;
- the historical backtest in src/backtest/engine.js.

All ingestion paths normalize to the canonical candle fields
open_time, close_time, timeframe, is_closed, and symbol. Primary signals
require a closed candle. REST ingestion explicitly removes the current
forming candle before evaluation.

## Research lineage

New signals carry model version, commit SHA, effective config hash, signal
engine version, generation time, candle boundaries, raw features, evidence,
filter reasons, status, and delivery status. The additive migration
supabase/migrations/20260828_signal_integrity.sql preserves existing rows.

## Historical experiments

Backtests use paginated Binance history and include warmup candles. The
coverage report contains:

requested_start, actual_start, actual_end, candles_expected, candles_loaded,
missing_candles, and coverage_percent.

Coverage below the hard gate fails the experiment. The account simulation is
kept as an auxiliary view; SignalEvaluator reports direction-normalized
1h/4h/8h/12h/24h/48h forward returns, MFE, MAE, time-to-excursion, TP/SL
ordering, and signal decay. These are research metrics, not user account
returns.

The strict loader also requires all warmup candles. A 100% requested window
with incomplete indicator warmup fails instead of silently shortening the
experiment. The requested window ends at the latest fully closed candle; the
currently forming interval is never counted as expected coverage.

Real BTCUSDT verification on 2026-09-01 used one fixed as-of time:

| Window | Loaded | Expected | Missing | Warmup | Coverage |
|---:|---:|---:|---:|---:|---:|
| 30d | 720 | 720 | 0 | 100/100 | 100% |
| 90d | 2160 | 2160 | 0 | 100/100 | 100% |
| 180d | 4320 | 4320 | 0 | 100/100 | 100% |
| 365d | 8760 | 8760 | 0 | 100/100 | 100% |

## Optimizer integrity

The production optimizer passes `candlesBySymbol`, `indicatorsBySymbol`, the
fixed as-of time, strict coverage, and strategy overrides into the same
backtest path. `trailingATR` is rejected unless every scenario enables
`trailingStop`. Each scenario records an effective execution-config hash and
a detailed output hash. Parameter-effect analysis compares scenarios while
holding all other parameters fixed; identical output from different
parameters is reported as a no-op and can fail the run.

The /api/signals endpoint is the read-only review surface for recent stored
signals; there is no separate /api/review handler in M0.

## Delivery state machine

eligible -> persisted -> delivery_pending -> delivered

Email failure becomes delivery_failed. Database insert/update errors are
raised and logged; delivered_at and email_sent_at are only written after
sendMail succeeds. If email succeeds but the confirmation update fails, the
record remains delivery_pending so deduplication blocks an automatic duplicate
send and the reconciliation failure remains observable.

## Production schema verification

The additive `m0_signal_integrity_additive` migration was applied to the
production `crypto-alerts` Supabase project on 2026-09-01. It added 22 lineage
and delivery-state columns plus `idx_signals_status`. Row count was 543 before
and after; the migration does not update, delete, or backfill historical rows.
Legacy rows therefore keep null M0 lineage fields, while every new application
record supplies them explicitly.

An additive review-schema sync migration records the existing production
review columns and indexes in the repository schema. The delivery state machine
also maintains legacy `email_delivery_status` (`pending`/`sent`/`failed`) beside
the M0 delivery fields so existing review consumers remain compatible.
The sync migration was applied on 2026-09-01: the row count remained 543,
the table has 62 columns and 9 indexes, and the post-DDL security advisor has
no finding for `crypto_signals`.

The repository bootstrap schema uses least-privilege table grants and does not
define an age-based signal deletion helper. Existing production role grants
were not revoked during M0 because changing them could disrupt other consumers
sharing the project; RLS policies remain enabled and unchanged. Production was
also verified to have no `clean_old_signals` function or related cron job.

## Runtime and scheduling

The locked Supabase JavaScript client requires Node 20 or newer, so the package
engine is Node >=20 and CI runs Node 22. Production Vercel is linked to
`SengC-it/crypto-alerts`, uses `main`, has `CRON_SECRET`, and the inspected
READY production deployment points to baseline commit
`4b63fa8e255aa747eaf57623aa3e72749e051343`.

The current Vercel team is on Hobby, which allows each cron definition to run
at most once per day. The checked-in schedules are therefore valid staggered
daily jobs. The configured 15m/1h/4h tier cadence requires Vercel Pro or an
external scheduler and is not activated by M0.

## Verification

    npm test
    npm run check
    npm run lint

Production promotion and main merge remain disabled for M0.

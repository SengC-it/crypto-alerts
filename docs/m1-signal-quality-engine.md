# M1 V2 Signal Quality Engine

This document records the reproducible M1 shadow-only experiment. It does not
authorize promotion, deployment, or automatic trading.

## Run

- Experiment ID: `m1-public_binance_futures_archive-2026-08-31`
- Model version: `m1-v2-quality-0.1.0`
- Reproduction command: `npm run m1:experiment -- --archive --days=60 --out=reports/m1-final.json`
- Data source: Binance public Futures daily archives (`data.binance.vision`)
- Historical range: `2026-06-28T20:00:00.000Z` through `2026-08-31T23:59:59.999Z`
- Symbols: 18 configured symbols, each with 1,540 closed 1h candles and 100% coverage
- Trigger: closed 1h candle; context: closed 4h candle aggregated only from four complete aligned 1h candles
- Horizons: 1h, 4h, 8h, 12h, 24h, 48h
- Round-trip fee and slippage assumption: `0.14%`

## Safety and data contract

- `V1_UNCHANGED=true`
- `V2_SHADOW_ONLY=true`
- `AUTO_TRADING=false`
- Every V2 candidate remains externally `SHADOW`; ranking buckets do not change that status.
- Indicators use the M0 exact closed-candle window and preserve M0 provenance/lineage.
- V2 never reads future candles. Breakout structure excludes the current trigger candle.
- V1 and V2 use the same symbols, candles, horizons, fees, slippage, event window, and OOS date windows for comparison.
- `raw_score` and `edge_score` are ranking scores, never probabilities. Calibration failure blocks promotion.
- The optional derivatives evidence interface accepts public funding, open interest, quote volume, and spread only; this run used candle archive data and no private exchange API.

## Purged walk-forward

- Status: `PASS`
- OOS windows: 11
- Positive OOS windows: 1
- Purge: 48h label-overlap rule
- Embargo: 24h
- Final holdout: 2,131 samples, isolated and untouched during tuning: `true`
- No threshold, symbol whitelist, direction deletion, or final-holdout tuning was used.

## V2 OOS result

| Metric | Value |
|---|---:|
| Evaluated signals | 2,845 |
| Independent market clusters | 180 |
| Net profit factor | 0.6498 |
| Net expectancy | -0.105590%/signal |
| Gross expectancy | 0.034410%/signal |
| Hit rate | 33.6731% |
| False-positive rate | 66.3269% |
| Average MFE | 4.237336% |
| Average MAE | -2.702581% |
| Signal decay, 48h minus 1h | 1.071593% |
| TP-first / SL-first | 0 / 0 |

Forward net expectancy by horizon was `-0.105590%`, `0.012687%`,
`0.092738%`, `0.127310%`, `0.474081%`, and `0.966003%` for 1h, 4h, 8h,
12h, 24h, and 48h respectively.

### Direction breadth

| Direction | Samples | Net expectancy | PF | Hit rate |
|---|---:|---:|---:|---:|
| BUY | 1,243 | -0.082304% | 0.7365 | 36.6854% |
| SELL | 1,602 | -0.123658% | 0.5781 | 31.3358% |

BUY was retained and evaluated independently; it was not removed from the
engine.

### Regime breadth

| Regime | Samples | Net expectancy | PF | Hit rate |
|---|---:|---:|---:|---:|
| Bull | 1,243 | -0.082304% | 0.7365 | 36.6854% |
| Bear | 1,602 | -0.123658% | 0.5781 | 31.3358% |
| Sideways | 0 | N/A | 0 | N/A |

### Volatility breadth

| Volatility | Samples | Net expectancy | PF | Hit rate |
|---|---:|---:|---:|---:|
| Low | 1,042 | -0.104705% | 0.5819 | 30.1344% |
| Normal | 964 | -0.104439% | 0.6444 | 34.5436% |
| High | 539 | -0.157847% | 0.5733 | 34.8794% |
| Extreme | 300 | -0.018476% | 0.9516 | 41.0000% |

## Calibration and promotion gate

- Calibration: `CALIBRATION_FAIL`
- Five score bins had enough samples, but OOS expectancy was not monotonic.
- Fixed promotion thresholds were unchanged: clusters `>=100`, net PF `>=1.25`, net expectancy `>=+0.15%/signal`, OOS windows `>=6`, positive windows `>=4/6`, symbol breadth `>=8`.
- Observed: 180 clusters, PF 0.6498, net expectancy -0.105590%/signal, 11 windows, 1 positive window, symbol breadth 18.
- Recommendation: `REJECT`
- Failed gates: net PF, net expectancy, positive windows, calibration.

## V1 comparator

The V1 comparator uses the same Purged-WFO OOS time windows and benchmark
contract:

| Metric | V1 | V2 |
|---|---:|---:|
| OOS samples | 153 | 2,845 |
| Net PF | 0.2748 | 0.6498 |
| Net expectancy | -0.271226%/signal | -0.105590%/signal |

V2 minus V1 was `+0.165636%/signal` net expectancy and `+0.3750` net PF.
This relative improvement does not override the absolute promotion gates.

## Known limitations

- This is signal-level forward evaluation, not account PnL or execution simulation.
- TP/SL fields remain null in the shadow lane, so TP-first and SL-first counts are zero; MFE/MAE and fixed-cost forward returns remain reported.
- The result covers a 60-day public archive range and should not be treated as a general profitability claim.
- Optional public funding/open-interest/spread evidence was not included in this run.
- No V2 production wiring, deployment, merge, or automatic order path is included.

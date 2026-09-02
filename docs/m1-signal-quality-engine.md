# M1 V2 Signal Quality Engine

This document records the reproducible M1 shadow-only experiment. It does not
authorize promotion, deployment, or automatic trading.

## Run

- Experiment ID: `m1-public_binance_futures_archive-2026-08-31`
- Model version: `m1-v2-quality-0.1.0`
- Source commit: `c9160c1`
- Config hash: `dc6d18ab7391e607462017b9e4ed286ec96440b9ce6b026c30039deb0a35219d`
- Reproduction command: `npm run m1:experiment -- --archive --days=60 --out=reports/m1-final.json`
- Data source: public Binance Futures archives (`data.binance.vision`)
- Historical range: `2026-06-28T20:00:00.000Z` through `2026-08-31T23:59:59.999Z`
- Symbols: 18 configured symbols, 1,540 closed 1h candles per symbol, 100% coverage
- Trigger/context: closed 1h candle with context from closed 4h candles
- Horizons: 1h, 4h, 8h, 12h, 24h, 48h
- Round-trip fee and slippage assumption: `0.14%`

## Safety and benchmark contract

- `V1_UNCHANGED=true`, `V2_SHADOW_ONLY=true`, `AUTO_TRADING=false`.
- Every V2 candidate remains externally `SHADOW`; selection status is research
  metadata only.
- Indicators use the M0 canonical closed-candle window. No future candle is
  read; breakout structure excludes the trigger candle.
- V1 and V2 use the same symbols, closed candles, horizons, costs, market-event
  definition, and OOS time windows.
- `raw_score` and `edge_score` are ranking scores, not probabilities.

## OOS selection and purged walk-forward

The trained score/volatility eligibility rule is applied first. Then only the
configured top-N candidate per independent `market_event_id` and direction
enters the primary V2 metrics. Remaining OOS rows stay in the audit lane as
`SCORE_INELIGIBLE`/`SHADOW` or `SCORE_ELIGIBLE_NOT_SELECTED`/`WATCH`.

| OOS lane | Count |
|---|---:|
| All candidates | 4,770 |
| Score-eligible candidates | 1,711 |
| Cluster-selected candidates | 261 |
| Independent market events | 171 |

- WFO status: `PASS`; 10 OOS windows; 1 positive window.
- Purge: 48h label-overlap rule; embargo: 24h.
- Final holdout: requested 2,131, actual 2,140 samples. The boundary was
  moved to keep all cross-sectional rows and events on one side.
- Development max timestamp `<` final-holdout min timestamp; event intersection
  is zero; `final_holdout_untouched=true`.
- Final-holdout hash:
  `6a25ed58059cbd5cced28b69ff85c59f8e177a84e7724605853730630595b7fe`.

## V2 primary OOS result

The following metrics use the 261 cluster-selected OOS records only.

| Metric | Value |
|---|---:|
| Evaluated signals | 261 |
| Independent market clusters | 164 |
| Net profit factor | 0.4533 |
| Net expectancy | -0.202178%/signal |
| Gross expectancy | -0.062178%/signal |
| Hit rate | 20.3065% |
| False-positive rate | 79.6935% |
| Average MFE | 3.338136% |
| Average MAE | -2.587405% |
| Signal decay, 48h minus 1h | 0.644696% |

### Direction breadth

| Direction | Samples | Net expectancy | PF | Hit rate |
|---|---:|---:|---:|---:|
| BUY | 111 | -0.273061% | 0.3179 | 18.9189% |
| SELL | 150 | -0.149725% | 0.5688 | 21.3333% |

### Trend regime breadth

| Regime | Samples | Net expectancy | PF | Hit rate |
|---|---:|---:|---:|---:|
| Bull | 111 | -0.273061% | 0.3179 | 18.9189% |
| Bear | 150 | -0.149725% | 0.5688 | 21.3333% |
| Sideways | 0 | N/A | 0 | N/A |

### Volatility breadth

| Volatility | Samples | Net expectancy | PF | Hit rate |
|---|---:|---:|---:|---:|
| Low | 120 | -0.202942% | 0.3998 | 16.6667% |
| Normal | 124 | -0.170717% | 0.5475 | 24.1935% |
| High | 11 | -0.286060% | 0.3061 | 18.1818% |
| Extreme | 6 | -0.683316% | 0.1153 | 16.6667% |

Volatility eligibility is selected separately from training data in each WFO
window. There is no hard-coded `Extreme = bad` rule. A gate is applied only
when the training evidence is sufficient; each policy records its version,
baseline, per-regime evidence, and selected regimes. The final holdout is not
used to fit any policy.

## Research TP/SL barriers

V2 uses the versioned, config-hashed research-only NATR barrier rule
`m1-research-natr-barriers-0.1.0`, derived from the canonical closed window.
It is not an execution or account-PnL rule. Barrier results are conservative
when both levels are touched in the same candle and ordering is unknowable.

| Outcome | Count |
|---|---:|
| TP-first | 81 |
| SL-first | 179 |
| Neither | 1 |
| Ambiguous same-candle | 0 |
| Conservative SL-first | 179 |

## Calibration, comparator, and promotion

- Calibration: `CALIBRATION_FAIL`; ranking scores are not probabilities and
  OOS expectancy is not monotonic across the five bins.
- V1: 130 OOS signals, 69 independent clusters, net PF `0.3000`, net
  expectancy `-0.263297%/signal`.
- V2: 261 selected OOS signals, 164 independent clusters, net PF `0.4533`,
  net expectancy `-0.202178%/signal`.
- V2 minus V1: `+0.061119%/signal` net expectancy and `+0.1533` PF under the
  same benchmark contract.
- Signal/cluster reduction: V2 all → selected `94.5283%`; eligible → selected
  `84.7458%`. The artifact also records V1 signals and clusters and all V2
  candidate/eligible/selected counts.
- Promotion recommendation: `REJECT`. Fixed promotion thresholds were not
  reduced; V2 was not merged, deployed, or wired to automatic trading.

The machine-readable artifact is [reports/m1-final.json](/D:/Codex/crypto-alerts/reports/m1-final.json).
It contains the exact benchmark, coverage, WFO boundaries, holdout hash,
per-window policies and metrics, selected-lane metrics, calibration, V1
comparator, and promotion result without raw candle payloads.

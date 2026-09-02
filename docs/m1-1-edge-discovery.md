# M1.1 Edge Discovery / Robust Signal Model Iteration

Decision: **NO_ROBUST_EDGE_FOUND**

- Base main SHA: `7566ba8c6972153d69904722542a118be6cd2b35`
- Experiment: `m1.1-public_binance_futures_archive-2026-08-20-m1.1-v2-edge-0.1.0`
- Model version: `m1.1-v2-edge-0.1.0`
- Source commit SHA: `299f744dfae9ce0fff34a8e028e4d3f7e83aea6d`
- Config hash: `0059f97b20669255e0ee496c4faa3d9b590e0fa8ed26c3c7e473782d11a8d762`
- Data source: public_binance_futures_archive
- Cost: 0.14% round trip; gross and net are signal-level metrics.

## Safety and holdout boundary

- V1_UNCHANGED=true
- V2_PRODUCTION_ENABLED=false
- V2_SHADOW_ONLY=true
- AUTO_TRADING=false
- M2_STARTED=false
- Frozen M1 final holdout boundary: 1787245199999; hash retained as metadata only.
- Old M1 final holdout outcomes accessed: **false**
- New M1.1 final holdout untouched: **true**

## Historical coverage

- Target: 180d (minimum 180d; preferred 365d)
- Requested range: 2026-02-21T16:00:00.000Z → 2026-08-20T15:59:59.999Z
| Symbol | Loaded | Expected | Missing | Coverage | Actual start | Actual end |
|---|---:|---:|---:|---:|---|---|
| BTCUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| ETHUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| SOLUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| BNBUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| XRPUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| ADAUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| AVAXUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| LINKUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| DOTUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| ARBUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| NEARUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| LTCUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| ATOMUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| UNIUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| APTUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| STXUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| IMXUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |
| AAVEUSDT | 4320 | 4320 | 0 | 100% | 2026-02-21T16:00:00.000Z | 2026-08-20T15:59:59.999Z |

Coverage complete: **true**; symbols: 18/18.

## Bounded candidate program

- Budget: 11/20 predeclared candidates
- Candidates evaluated: 11
- Primary candidate: `A-equal-weight-train-event-top1`
- Best candidate passing all fixed gates: `NONE`

| Candidate | Score method | Horizon policy | Event policy | Top-N | Selected OOS | Clusters | PF | Expectancy | Positive windows | Calibration | Decision |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---|---|
| A-equal-weight-train-event-top1 | equal_weight | train_selected_per_setup | train_select | 1 | 863 | 822 | 0.9196 | -0.092306% | 4/11 | CALIBRATION_FAIL | REJECT |
| B-empirical-global-train-event-top1 | empirical_global | train_selected_per_setup | train_select | 1 | 863 | 822 | 0.9196 | -0.092306% | 4/11 | CALIBRATION_FAIL | REJECT |
| C-empirical-setup-train-event-top1 | empirical_setup | train_selected_per_setup | train_select | 1 | 867 | 825 | 0.9274 | -0.08318% | 4/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-minus-trend | equal_weight | train_selected_per_setup | train_select | 1 | 883 | 816 | 0.8371 | -0.203037% | 2/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-minus-momentum | equal_weight | train_selected_per_setup | train_select | 1 | 872 | 827 | 0.9214 | -0.089732% | 4/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-minus-participation | equal_weight | train_selected_per_setup | train_select | 1 | 840 | 825 | 0.8452 | -0.199322% | 4/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-minus-market-structure | equal_weight | train_selected_per_setup | train_select | 1 | 863 | 822 | 0.9196 | -0.092306% | 4/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-minus-higher-timeframe | equal_weight | train_selected_per_setup | train_select | 1 | 851 | 811 | 0.9175 | -0.096209% | 4/11 | CALIBRATION_FAIL | REJECT |
| B-empirical-global-train-event-topN | empirical_global | train_selected_per_setup | train_select | train_select | 1047 | 822 | 0.8746 | -0.164879% | 3/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-fixed-1h-event-top1 | equal_weight | train_selected_per_setup | fixed_1h | 1 | 863 | 822 | 0.9196 | -0.092306% | 4/11 | CALIBRATION_FAIL | REJECT |
| A-equal-weight-fixed-4h-event-top1 | equal_weight | train_selected_per_setup | fixed_4h | 1 | 423 | 351 | 0.8329 | -0.218588% | 3/11 | CALIBRATION_FAIL | REJECT |

## Best/reference candidate metrics

- Scope: bounded candidate; no scope inferred from the frozen M1 holdout
- Score method: equal_weight; no probability claim.
- Primary horizon policy: train-selected per setup; {"Trend Continuation":1,"Mean Reversion":1,"Breakout":4}
- Market-event policy: {"version":"m1.1-training-market-event-policy-0.1.0","training_only":true,"selection_basis":"training_primary_outcome_with_predeclared_1h_4h_candidates","selected_window_hours":1,"candidates":[{"window_hours":1,"eligible_candidates":4255,"selected_candidates":795,"independent_clusters":738,"net_expectancy_percent":-0.15011,"net_profit_factor":0.7055,"selection_score":-0.15011003},{"window_hours":4,"eligible_candidates":4255,"selected_candidates":347,"independent_clusters":265,"net_expectancy_percent":-0.44837,"net_profit_factor":0.3561,"selection_score":-0.44836965}]}
- Cluster Top-N: 1
- Selected OOS signals: 863; independent clusters: 822
- Gross PF: 1.0445; net PF: 0.9196
- Gross expectancy: 0.047694%; net expectancy: -0.092306%
- Hit rate: 41.7149%; false-positive rate: 58.2851%
- Average MFE: 4.824557%; average MAE: -3.901913%
- TP-first: 346; SL-first: 511; Neither: 0; Ambiguous: 6
- Forward returns: {"1h":{"count":863,"gross_expectancy_percent":0.009634,"net_expectancy_percent":-0.130366,"gross_profit_factor":1.0279,"net_profit_factor":0.6949,"hit_rate_percent":36.6165},"4h":{"count":863,"gross_expectancy_percent":-0.035475,"net_expectancy_percent":-0.175475,"gross_profit_factor":0.946,"net_profit_factor":0.7612,"hit_rate_percent":41.8308},"8h":{"count":863,"gross_expectancy_percent":0.027218,"net_expectancy_percent":-0.112782,"gross_profit_factor":1.0323,"net_profit_factor":0.8775,"hit_rate_percent":42.8737},"12h":{"count":863,"gross_expectancy_percent":0.055714,"net_expectancy_percent":-0.084286,"gross_profit_factor":1.056,"net_profit_factor":0.9215,"hit_rate_percent":42.4102},"24h":{"count":863,"gross_expectancy_percent":0.32596,"net_expectancy_percent":0.18596,"gross_profit_factor":1.2664,"net_profit_factor":1.1436,"hit_rate_percent":48.2039},"48h":{"count":863,"gross_expectancy_percent":0.354149,"net_expectancy_percent":0.214149,"gross_profit_factor":1.1989,"net_profit_factor":1.1159,"hit_rate_percent":50.9849}}
- Signal decay: 0.344514%
- Stability: median expectancy -0.116202%; worst -1.023721%; median PF 0.7427; worst PF 0.3322; dispersion 1.658633%
- Positive windows: 4/11 (0.363636)
- Breadth: symbols 18; directions 2; setups 2; trend regimes 2; volatility regimes 3

### Setup family ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Trend Continuation | 11012 | 2089 | 658 | 629 | 0.9292 | -0.075399% | CALIBRATION_FAIL |
| Mean Reversion | 1328 | 0 | 0 | 0 | N/A | N/A | CALIBRATION_FAIL |
| Breakout | 3080 | 614 | 205 | 204 | 0.8963 | -0.146574% | CALIBRATION_FAIL |

### Direction ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| BUY | 7511 | 1501 | 491 | 491 | 1.0415 | 0.049342% | CALIBRATION_FAIL |
| SELL | 7909 | 1202 | 372 | 372 | 0.7445 | -0.279267% | CALIBRATION_FAIL |

### Trend regime ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Bull | 6490 | 1501 | 491 | 491 | 1.0415 | 0.049342% | CALIBRATION_FAIL |
| Bear | 7005 | 1202 | 372 | 372 | 0.7445 | -0.279267% | CALIBRATION_FAIL |
| Sideways | 1925 | 0 | 0 | 0 | N/A | N/A | CALIBRATION_FAIL |

### Volatility regime ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Low | 3226 | 613 | 203 | 194 | 1.072 | 0.092227% | CALIBRATION_FAIL |
| Normal | 4294 | 821 | 258 | 253 | 0.6477 | -0.105979% | CALIBRATION_FAIL |
| High | 4194 | 0 | 0 | 0 | N/A | N/A | CALIBRATION_FAIL |
| Extreme | 3706 | 1269 | 402 | 389 | 0.8913 | -0.176716% | CALIBRATION_FAIL |

### Evidence-group ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Trend | 15420 | 2703 | 863 | 822 | 0.9196 | -0.092306% | CALIBRATION_FAIL |
| Momentum | 15420 | 2703 | 863 | 822 | 0.9196 | -0.092306% | CALIBRATION_FAIL |
| Participation | 15420 | 2703 | 863 | 822 | 0.9196 | -0.092306% | CALIBRATION_FAIL |
| Volatility | 15420 | 2703 | 863 | 822 | 0.9196 | -0.092306% | CALIBRATION_FAIL |
| Market Structure | 15420 | 2703 | 863 | 822 | 0.9196 | -0.092306% | CALIBRATION_FAIL |
| Higher Timeframe | 15420 | 2703 | 863 | 822 | 0.9196 | -0.092306% | CALIBRATION_FAIL |

## Sideways / Mean Reversion diagnosis

- Conclusion: **D_SCORE_RANKING_SUPPRESSION**
- Prior-only classifier trigger windows: 77778; Sideways triggers: 16140
- Sideways eligible setup candidates by generation: {"Trend Continuation":0,"Mean Reversion":2790,"Breakout":1485}
- Primary OOS Sideways candidates: 1925; Mean Reversion: 1328
- Primary OOS score-threshold eligible: 0; volatility eligible: 620; volatility filtered: 0; cluster selected: 0; ranking excluded: 0

## Train-selected policies by WFO window

| Window | Event hours | Horizons by setup | Score threshold | Top-N | Volatility gate |
|---:|---:|---|---:|---:|---|
| 0 | 1h | {"Trend Continuation":1,"Mean Reversion":1,"Breakout":4} | 79.577721 | 1 | ["Extreme"] |
| 1 | 1h | {"Trend Continuation":1,"Mean Reversion":24,"Breakout":1} | 80.389458 | 1 | ["Normal","Extreme"] |
| 2 | 1h | {"Trend Continuation":1,"Mean Reversion":24,"Breakout":4} | 80.02450400000001 | 1 | ["Normal","Extreme"] |
| 3 | 1h | {"Trend Continuation":1,"Mean Reversion":24,"Breakout":1} | 79.72905800000001 | 1 | ["Low","Normal","Extreme"] |
| 4 | 1h | {"Trend Continuation":1,"Mean Reversion":24,"Breakout":1} | 80.2732375 | 1 | ["Low","Normal"] |
| 5 | 1h | {"Trend Continuation":48,"Mean Reversion":24,"Breakout":1} | 80.265975 | 1 | ["Low"] |
| 6 | 1h | {"Trend Continuation":48,"Mean Reversion":24,"Breakout":1} | 79.930258 | 1 | ["Low"] |
| 7 | 1h | {"Trend Continuation":48,"Mean Reversion":24,"Breakout":48} | 80.777775 | 1 | ["Extreme"] |
| 8 | 1h | {"Trend Continuation":48,"Mean Reversion":24,"Breakout":48} | 80.653392 | 1 | ["Low","Extreme"] |
| 9 | 1h | {"Trend Continuation":48,"Mean Reversion":24,"Breakout":48} | 80.8515295 | 1 | ["Low","Extreme"] |
| 10 | 1h | {"Trend Continuation":48,"Mean Reversion":24,"Breakout":48} | 80.998417 | 1 | ["Extreme"] |

## BUY / SELL and setup scope

- BUY: {"sample_count":491,"evaluated_count":491,"net_expectancy_percent":0.049342,"gross_expectancy_percent":0.189342,"net_profit_factor":1.0415,"gross_profit_factor":1.1702,"hit_rate_percent":41.3442,"false_positive_rate_percent":58.6558,"avg_mfe_percent":5.762986,"avg_mae_percent":-4.080548,"tp_first_count":193,"sl_first_count":294,"neither_count":0,"ambiguous_count":4,"tp_first_rate_percent":39.3075,"sl_first_rate_percent":59.8778,"conservative_sl_first_count":298}
- SELL: {"sample_count":372,"evaluated_count":372,"net_expectancy_percent":-0.279267,"gross_expectancy_percent":-0.139267,"net_profit_factor":0.7445,"gross_profit_factor":0.8633,"hit_rate_percent":42.2043,"false_positive_rate_percent":57.7957,"avg_mfe_percent":3.585932,"avg_mae_percent":-3.666133,"tp_first_count":153,"sl_first_count":217,"neither_count":0,"ambiguous_count":2,"tp_first_rate_percent":41.129,"sl_first_rate_percent":58.3333,"conservative_sl_first_count":219}
- Trend Continuation: {"sample_count":658,"evaluated_count":658,"net_expectancy_percent":-0.075399,"gross_expectancy_percent":0.064601,"net_profit_factor":0.9292,"gross_profit_factor":1.0651,"hit_rate_percent":42.8571,"false_positive_rate_percent":57.1429,"avg_mfe_percent":4.688174,"avg_mae_percent":-3.670904,"tp_first_count":275,"sl_first_count":380,"neither_count":0,"ambiguous_count":3,"tp_first_rate_percent":41.7933,"sl_first_rate_percent":57.7508,"conservative_sl_first_count":383}
- Mean Reversion: {"sample_count":0,"evaluated_count":0,"net_expectancy_percent":null,"gross_expectancy_percent":null,"net_profit_factor":null,"gross_profit_factor":null,"hit_rate_percent":null,"false_positive_rate_percent":null,"avg_mfe_percent":null,"avg_mae_percent":null,"tp_first_count":0,"sl_first_count":0,"neither_count":0,"ambiguous_count":0,"tp_first_rate_percent":null,"sl_first_rate_percent":null,"conservative_sl_first_count":0}
- Breakout: {"sample_count":205,"evaluated_count":205,"net_expectancy_percent":-0.146574,"gross_expectancy_percent":-0.006574,"net_profit_factor":0.8963,"gross_profit_factor":0.9951,"hit_rate_percent":38.0488,"false_positive_rate_percent":61.9512,"avg_mfe_percent":5.262312,"avg_mae_percent":-4.643394,"tp_first_count":71,"sl_first_count":131,"neither_count":0,"ambiguous_count":3,"tp_first_rate_percent":34.6341,"sl_first_rate_percent":63.9024,"conservative_sl_first_count":134}

## Concentration and calibration

- Max symbol cluster share: 0.149479
- Max regime cluster share: 0.568946
- Concentration risk: **false**
- Unstable edge: **true**
- Calibration: **CALIBRATION_FAIL**; bins: 5; monotonic: false

## V1 and M1 comparators

- V1 comparator horizon: 1h_selected_oos_comparator
- V1 PF: 0.5254; V1 expectancy: -0.190514%
- M1 baseline PF: 0.4533; M1 baseline expectancy: -0.202178%
- M1.1 vs V1: PF delta 0.1695; expectancy delta 0.060148%
- M1.1 vs M1: PF delta 0.4663; expectancy delta 0.109872%; selected-signal delta 602
- Same candles, cost assumptions, closed-candle contract, horizons and event policy: true

## Promotion and limitations

- Promotion gate: **REJECT**
- Observed: {"independent_clusters":822,"net_profit_factor":0.9196,"net_expectancy_percent":-0.092306,"oos_windows":11,"positive_windows":4,"positive_window_ratio":0.363636,"symbol_breadth":18,"calibration":"CALIBRATION_FAIL"}
- Failures: net_profit_factor, net_expectancy_percent, positive_window_ratio, calibration
- Public derivatives data used: **false**
- This bounded run uses candle-only public Binance Futures data. Funding/OI/spread features were not admitted without a separate point-in-time incremental OOS test.
- The 180d target is intentionally frozen before the old M1 holdout boundary; symbols remain the configured 18-symbol universe and are never blacklisted by result.
- All score, horizon, volatility, event and Top-N policies are fit per training window. The final holdout is reserved for a later validation phase and is not opened here.
- `edge_score`, `learned_score` and calibration bins are ordering diagnostics, not win probabilities.

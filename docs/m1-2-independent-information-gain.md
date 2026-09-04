# M1.2 Independent Information Gain / Public Derivatives

Decision: **NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN**

- Base main SHA: `4842be0c7b1e1748f933ab4b78f62ecd0fc7f776`; M1.1 closeout PR: #3.
- Experiment: `m1.2-public_binance_futures_archive-2026-08-20-m1.2-v2-independent-information-gain-0.1.0`
- Model/version: `m1.2-v2-independent-information-gain-0.1.0` / `m1.2-pit-derivatives-0.1.0`
- Source commit SHA: `c59a115f4aeb1f50563152749a876c0a7936e18a`
- Config hash: `e44c5628e1fdfc81f875f06b0822551f68867f085c8ad723844a0f74ba878404`
- Data source: public_binance_futures_archive
- Cost: 0.14% round trip; diagnostics are signal-level gross/net values.

## Safety and holdout boundary

- V1_UNCHANGED=true
- V2_PRODUCTION_ENABLED=false
- V2_SHADOW_ONLY=true
- AUTO_TRADING=false
- M2_STARTED=false
- Old M1 final holdout outcomes accessed: **false**
- New M1.2 final holdout untouched: **true**
- COMMON_SUPPORT_COMPARISON=true

## Historical and derivative coverage

- Target: 180d × 18 configured symbols
- Requested range: 2026-02-21T16:00:00.000Z → 2026-08-20T15:59:59.999Z
- Candle coverage complete: **true**; symbols: 18/18.

| Family | Admitted | Coverage threshold | Notes |
|---|---:|---:|---|
| Funding | true | 98% | PASS |
| Open Interest | true | 98% | PASS |
| Basis/Premium | true | 98% | PASS |
| Taker Flow | true | 98% | PASS |

- Admitted families: ["Funding","Open Interest","Basis/Premium","Taker Flow"]
- Rejected families: []
- Liquidations: LIQUIDATION_DATA_NOT_ADMITTED
- Order book: NO_HISTORICAL_ORDERBOOK_PROXY_AS_REAL_ORDERBOOK
- OI sampling: latest public metrics row per UTC hour; original source timestamps retained

## Frozen baseline and predeclared candidates

- Frozen candle-only baseline: `A-equal-weight-train-event-top1`
- Candidate budget: 10/16 predeclared candidates
- Diagnostic largest observed delta (not a selection rule): `C1-baseline-plus-funding`

| Candidate | Families | Status | Selected OOS | Clusters | Net PF | Net expectancy | Gain gate | Absolute gate |
|---|---|---|---:|---:|---:|---:|---|---|
| C0-candle-only-frozen-m1.1-baseline | candle-only | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C1-baseline-plus-funding | Funding | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C2-baseline-plus-open-interest | Open Interest | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C3-baseline-plus-basis-premium | Basis/Premium | EVALUATED | 854 | 813 | 0.8966 | -0.119731% | false | false |
| C4-baseline-plus-taker-flow | Taker Flow | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C5-funding-plus-open-interest | Funding, Open Interest | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C6-open-interest-plus-taker-flow | Open Interest, Taker Flow | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C7-funding-plus-basis-premium | Funding, Basis/Premium | EVALUATED | 854 | 813 | 0.8966 | -0.119731% | false | false |
| C8-funding-plus-open-interest-plus-taker-flow | Funding, Open Interest, Taker Flow | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false |
| C9-all-admitted-independent-families | Funding, Open Interest, Basis/Premium, Taker Flow | EVALUATED | 854 | 813 | 0.8966 | -0.119731% | false | false |

## Baseline and augmented comparison

- Baseline net PF: 0.9196; net expectancy: -0.092306%; calibration: CALIBRATION_FAIL.
- Diagnostic augmented candidate: `C1-baseline-plus-funding`; information gain: false.
- Common support clusters: 863; paired cluster count: 863.
- Common-support contract: true; same OOS windows: true.
- Point delta net expectancy: 0%; delta net PF: 0.
- Bootstrap: 2000 repetitions; delta expectancy 95% CI [0,0]; P(delta expectancy > 0)=0.
- Bootstrap delta PF 95% CI: [0,0]; seed: 20260904.

## Information-family ablation

| Family | Candidate IDs | Best candidate | Gain gate |
|---|---|---|---:|
| Funding | C1-baseline-plus-funding, C5-funding-plus-open-interest, C7-funding-plus-basis-premium, C8-funding-plus-open-interest-plus-taker-flow, C9-all-admitted-independent-families | C1-baseline-plus-funding | false |
| Open Interest | C2-baseline-plus-open-interest, C5-funding-plus-open-interest, C6-open-interest-plus-taker-flow, C8-funding-plus-open-interest-plus-taker-flow, C9-all-admitted-independent-families | C2-baseline-plus-open-interest | false |
| Basis/Premium | C3-baseline-plus-basis-premium, C7-funding-plus-basis-premium, C9-all-admitted-independent-families | C3-baseline-plus-basis-premium | false |
| Taker Flow | C4-baseline-plus-taker-flow, C6-open-interest-plus-taker-flow, C8-funding-plus-open-interest-plus-taker-flow, C9-all-admitted-independent-families | C4-baseline-plus-taker-flow | false |

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

### Setup-family ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Trend Continuation | 11012 | 2089 | 658 | 629 | 0.9292 | -0.075399% | CALIBRATION_FAIL |
| Mean Reversion | 1328 | 0 | 0 | 0 | N/A | N/A | CALIBRATION_FAIL |
| Breakout | 3080 | 614 | 205 | 204 | 0.8963 | -0.146574% | CALIBRATION_FAIL |

## Required failure-mode checks

- BUY/SELL slices are retained: {"BUY":{"sample_count":491,"evaluated_count":491,"net_expectancy_percent":0.049342,"gross_expectancy_percent":0.189342,"net_profit_factor":1.0415,"gross_profit_factor":1.1702,"hit_rate_percent":41.3442,"false_positive_rate_percent":58.6558,"avg_mfe_percent":5.762986,"avg_mae_percent":-4.080548,"tp_first_count":193,"sl_first_count":294,"neither_count":0,"ambiguous_count":4,"tp_first_rate_percent":39.3075,"sl_first_rate_percent":59.8778,"conservative_sl_first_count":298},"SELL":{"sample_count":372,"evaluated_count":372,"net_expectancy_percent":-0.279267,"gross_expectancy_percent":-0.139267,"net_profit_factor":0.7445,"gross_profit_factor":0.8633,"hit_rate_percent":42.2043,"false_positive_rate_percent":57.7957,"avg_mfe_percent":3.585932,"avg_mae_percent":-3.666133,"tp_first_count":153,"sl_first_count":217,"neither_count":0,"ambiguous_count":2,"tp_first_rate_percent":41.129,"sl_first_rate_percent":58.3333,"conservative_sl_first_count":219}}
- Sideways/Mean Reversion diagnosis: **D_SCORE_RANKING_SUPPRESSION**
- Sideways mean-reversion candidates: 2790; no post-hoc whitelist or threshold change was applied.

## Cost sensitivity (diagnostic only)

| Round-trip cost | Candidate count | Selection impact |
|---:|---:|---|
| 0.1% | 10 | diagnostic_only; not used for candidate selection |
| 0.14% | 10 | diagnostic_only; not used for candidate selection |
| 0.2% | 10 | diagnostic_only; not used for candidate selection |

## WFO, calibration and concentration

- WFO windows: 11; purge: 48h; embargo: 24h; label horizon: 48h.
- Baseline calibration: **CALIBRATION_FAIL**; augmented diagnostic calibration: **CALIBRATION_FAIL**.
- Baseline concentration: {"independent_cluster_count":822,"symbol":{"counts":{"AAVEUSDT":129,"APTUSDT":109,"ATOMUSDT":74,"ADAUSDT":69,"IMXUSDT":57,"ARBUSDT":57,"UNIUSDT":52,"BNBUSDT":40,"AVAXUSDT":37,"BTCUSDT":30,"STXUSDT":30,"DOTUSDT":28,"NEARUSDT":22,"LTCUSDT":21,"ETHUSDT":21,"SOLUSDT":18,"XRPUSDT":14,"LINKUSDT":14},"max_share":0.156934,"max_key":"AAVEUSDT"},"regime":{"counts":{"Bull":468,"Bear":354},"max_share":0.569343,"max_key":"Bull"},"direction":{"counts":{"BUY":468,"SELL":354},"max_share":0.569343,"max_key":"BUY"},"setup":{"counts":{"Trend Continuation":624,"Breakout":198},"max_share":0.759124,"max_key":"Trend Continuation"},"max_symbol_cluster_share":0.156934,"max_regime_cluster_share":0.569343,"max_direction_cluster_share":0.569343,"max_setup_cluster_share":0.759124,"record_level":{"symbol":{"AAVEUSDT":129,"DOTUSDT":30,"NEARUSDT":28,"LTCUSDT":24,"APTUSDT":110,"BTCUSDT":31,"ADAUSDT":69,"ETHUSDT":21,"BNBUSDT":43,"STXUSDT":33,"LINKUSDT":15,"IMXUSDT":62,"XRPUSDT":17,"ATOMUSDT":80,"ARBUSDT":57,"UNIUSDT":57,"AVAXUSDT":39,"SOLUSDT":18},"regime":{"Bull":491,"Bear":372},"direction":{"BUY":491,"SELL":372},"setup":{"Breakout":205,"Trend Continuation":658},"selected_records":863}}
- Augmented concentration: {"independent_cluster_count":822,"symbol":{"counts":{"AAVEUSDT":129,"APTUSDT":109,"ATOMUSDT":74,"ADAUSDT":69,"IMXUSDT":57,"ARBUSDT":57,"UNIUSDT":52,"BNBUSDT":40,"AVAXUSDT":37,"BTCUSDT":30,"STXUSDT":30,"DOTUSDT":28,"NEARUSDT":22,"LTCUSDT":21,"ETHUSDT":21,"SOLUSDT":18,"XRPUSDT":14,"LINKUSDT":14},"max_share":0.156934,"max_key":"AAVEUSDT"},"regime":{"counts":{"Bull":468,"Bear":354},"max_share":0.569343,"max_key":"Bull"},"direction":{"counts":{"BUY":468,"SELL":354},"max_share":0.569343,"max_key":"BUY"},"setup":{"counts":{"Trend Continuation":624,"Breakout":198},"max_share":0.759124,"max_key":"Trend Continuation"},"max_symbol_cluster_share":0.156934,"max_regime_cluster_share":0.569343,"max_direction_cluster_share":0.569343,"max_setup_cluster_share":0.759124,"record_level":{"symbol":{"AAVEUSDT":129,"DOTUSDT":30,"NEARUSDT":28,"LTCUSDT":24,"APTUSDT":110,"BTCUSDT":31,"ADAUSDT":69,"ETHUSDT":21,"BNBUSDT":43,"STXUSDT":33,"LINKUSDT":15,"IMXUSDT":62,"XRPUSDT":17,"ATOMUSDT":80,"ARBUSDT":57,"UNIUSDT":57,"AVAXUSDT":39,"SOLUSDT":18},"regime":{"Bull":491,"Bear":372},"direction":{"BUY":491,"SELL":372},"setup":{"Breakout":205,"Trend Continuation":658},"selected_records":863}}
- Final holdout: {"count":6301,"start":1783861199999,"hash":"294e6cecb24eeb4ac5041d0bba74e0e0e04301092c13e0c454d862dcaafd40bb","untouched":true,"outcomes_accessed_for_selection":false}

## Decision and limitations

- Information-gain decision: **NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN**
- Known limitations: ["This bounded run targets 180d and the configured 18-symbol universe; no symbols were blacklisted by result.","Only public Binance Vision archives were admitted. Liquidations were not admitted and no historical order-book proxy was used.","Open-interest metrics were reduced to the latest source row per UTC hour for memory-bounded, conservative PIT lookup.","All candidate normalization, train scalers, signs, thresholds and combination rules are fit inside each WFO training window.","The old M1 final holdout was filtered before labels were read; the new WFO final holdout was not used for selection.","Cost sensitivity at 0.10%, 0.14% and 0.20% is diagnostic only and cannot change the decision.","Information-gain comparisons resample independent market-event clusters with deterministic bootstrap settings."]

# M1.2 Independent Information Gain / Public Derivatives

Decision: **NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN**

- Base main SHA: `4842be0c7b1e1748f933ab4b78f62ecd0fc7f776`; M1.1 closeout PR: #3.
- Experiment: `m1.2-public_binance_futures_archive-2026-08-20-m1.2-v2-independent-information-gain-0.1.1`
- Model/version: `m1.2-v2-independent-information-gain-0.1.1` / `m1.2-pit-derivatives-0.1.1`
- Experiment source SHA: `57668249bd3bee94e3ea6f41cf772b1582391d58`
- Config hash: `ce72572182fa767126a6a7c2a8ab4622b458f5785c889da7e8ef6f2bb3c9442b`
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
- Diagnostic largest observed delta (not a selection rule): `C7-funding-plus-basis-premium`

| Candidate | Families | Status | Selected OOS | Clusters | Net PF | Net expectancy | Gain gate | Absolute gate | No-op |
|---|---|---|---:|---:|---:|---:|---|---|---|
| C0-candle-only-frozen-m1.1-baseline | candle-only | EVALUATED | 863 | 822 | 0.9196 | -0.092306% | false | false | false |
| C1-baseline-plus-funding | Funding | EVALUATED | 563 | 546 | 0.9016 | -0.130514% | false | false | false |
| C2-baseline-plus-open-interest | Open Interest | EVALUATED | 484 | 470 | 0.7589 | -0.242039% | false | false | false |
| C3-baseline-plus-basis-premium | Basis/Premium | EVALUATED | 585 | 561 | 0.7835 | -0.221874% | false | false | false |
| C4-baseline-plus-taker-flow | Taker Flow | EVALUATED | 536 | 524 | 0.7169 | -0.237359% | false | false | false |
| C5-funding-plus-open-interest | Funding, Open Interest | EVALUATED | 531 | 513 | 0.8331 | -0.189505% | false | false | false |
| C6-open-interest-plus-taker-flow | Open Interest, Taker Flow | EVALUATED | 470 | 461 | 0.8029 | -0.165365% | false | false | false |
| C7-funding-plus-basis-premium | Funding, Basis/Premium | EVALUATED | 596 | 574 | 0.9093 | -0.095586% | false | false | false |
| C8-funding-plus-open-interest-plus-taker-flow | Funding, Open Interest, Taker Flow | EVALUATED | 472 | 463 | 0.7448 | -0.253997% | false | false | false |
| C9-all-admitted-independent-families | Funding, Open Interest, Basis/Premium, Taker Flow | EVALUATED | 497 | 487 | 0.7716 | -0.213404% | false | false | false |

## Baseline and augmented comparison

- Baseline net PF: 0.9196; net expectancy: -0.092306%; calibration: CALIBRATION_FAIL.
- Diagnostic augmented candidate: `C7-funding-plus-basis-premium`; information gain: false.
- Underlying OOS events: 2001; PIT-valid common events: 1979.
- Baseline action events: 813; augmented action events: 574; paired independent market events: 1979.
- Common-support contract: true; same OOS windows: true.
- Point delta net expectancy: 0.01337622%; delta net PF: -0.0028.
- Bootstrap unit: market_event_id; 2000 repetitions; delta expectancy 95% CI [-0.08124882,0.11298228]; P(delta expectancy > 0)=0.6095.
- Bootstrap delta PF 95% CI: [-0.2408,0.2744]; seed: 20260904.

## Derivative integration-effect audit

| Candidate | WFO window | Base eligible | Augmented eligible | Promoted | Demoted | Ranking changed | Selected records changed | Selected events changed | Derivative variance | Integration no-op |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| C1-baseline-plus-funding | 0 | 252 | 121 | 0 | 131 | 199 | 60 | 39 | 59.74555943059711 | false |
| C1-baseline-plus-funding | 1 | 265 | 178 | 28 | 115 | 209 | 70 | 33 | 41.08509266570277 | false |
| C1-baseline-plus-funding | 2 | 380 | 94 | 24 | 310 | 364 | 127 | 66 | 48.613767793001145 | false |
| C1-baseline-plus-funding | 3 | 503 | 228 | 56 | 331 | 486 | 124 | 40 | 53.58499567057795 | false |
| C1-baseline-plus-funding | 4 | 395 | 116 | 5 | 284 | 366 | 124 | 55 | 47.20511653113456 | false |
| C1-baseline-plus-funding | 5 | 81 | 8 | 0 | 73 | 76 | 37 | 31 | 55.17371301688865 | false |
| C1-baseline-plus-funding | 6 | 25 | 0 | 0 | 25 | 25 | 11 | 11 | 65.82179831242078 | false |
| C1-baseline-plus-funding | 7 | 115 | 41 | 0 | 74 | 83 | 28 | 18 | 77.98871651748149 | false |
| C1-baseline-plus-funding | 8 | 382 | 126 | 23 | 279 | 365 | 135 | 63 | 92.82195043492564 | false |
| C1-baseline-plus-funding | 9 | 214 | 229 | 89 | 74 | 249 | 102 | 34 | 88.77070639295414 | false |
| C1-baseline-plus-funding | 10 | 91 | 62 | 13 | 42 | 66 | 30 | 20 | 103.18384097366713 | false |
| C1-baseline-plus-funding | TOTAL | 2703 | 1203 | 238 | 1738 | 2488 | 848 | 410 | 76.07504071868554 | false |
| C2-baseline-plus-open-interest | 0 | 252 | 118 | 18 | 152 | 220 | 70 | 47 | 101.72430736209826 | false |
| C2-baseline-plus-open-interest | 1 | 265 | 137 | 29 | 157 | 228 | 88 | 54 | 71.12441287365058 | false |
| C2-baseline-plus-open-interest | 2 | 380 | 253 | 54 | 181 | 347 | 126 | 65 | 73.11738235689863 | false |
| C2-baseline-plus-open-interest | 3 | 503 | 431 | 121 | 193 | 448 | 133 | 44 | 112.08075882477328 | false |
| C2-baseline-plus-open-interest | 4 | 395 | 79 | 14 | 330 | 374 | 124 | 72 | 83.88611091910816 | false |
| C2-baseline-plus-open-interest | 5 | 81 | 2 | 0 | 79 | 80 | 38 | 36 | 109.56940743411495 | false |
| C2-baseline-plus-open-interest | 6 | 25 | 1 | 1 | 25 | 26 | 12 | 12 | 167.44873949202469 | false |
| C2-baseline-plus-open-interest | 7 | 115 | 57 | 5 | 63 | 86 | 39 | 33 | 110.43334538427912 | false |
| C2-baseline-plus-open-interest | 8 | 382 | 281 | 44 | 145 | 261 | 104 | 56 | 76.32553392244898 | false |
| C2-baseline-plus-open-interest | 9 | 214 | 36 | 6 | 184 | 209 | 76 | 59 | 83.43967625596349 | false |
| C2-baseline-plus-open-interest | 10 | 91 | 18 | 2 | 75 | 88 | 45 | 34 | 76.47726907944651 | false |
| C2-baseline-plus-open-interest | TOTAL | 2703 | 1413 | 294 | 1584 | 2367 | 855 | 510 | 105.12896017518958 | false |
| C3-baseline-plus-basis-premium | 0 | 252 | 86 | 7 | 173 | 217 | 80 | 57 | 111.75087980105862 | false |
| C3-baseline-plus-basis-premium | 1 | 265 | 170 | 44 | 139 | 248 | 95 | 41 | 96.7465086080078 | false |
| C3-baseline-plus-basis-premium | 2 | 380 | 260 | 72 | 192 | 332 | 132 | 59 | 93.2694691475283 | false |
| C3-baseline-plus-basis-premium | 3 | 503 | 367 | 92 | 228 | 434 | 128 | 53 | 106.7323239497444 | false |
| C3-baseline-plus-basis-premium | 4 | 395 | 165 | 34 | 264 | 363 | 142 | 41 | 70.2353642696931 | false |
| C3-baseline-plus-basis-premium | 5 | 81 | 5 | 1 | 77 | 80 | 38 | 34 | 70.70147324423242 | false |
| C3-baseline-plus-basis-premium | 6 | 25 | 6 | 2 | 21 | 24 | 11 | 9 | 88.67782146521482 | false |
| C3-baseline-plus-basis-premium | 7 | 115 | 32 | 2 | 85 | 102 | 37 | 33 | 74.55567263345364 | false |
| C3-baseline-plus-basis-premium | 8 | 382 | 177 | 43 | 248 | 351 | 128 | 50 | 76.98638502523059 | false |
| C3-baseline-plus-basis-premium | 9 | 214 | 88 | 28 | 154 | 221 | 87 | 47 | 124.35869911689416 | false |
| C3-baseline-plus-basis-premium | 10 | 91 | 38 | 9 | 62 | 82 | 42 | 27 | 98.76838310252126 | false |
| C3-baseline-plus-basis-premium | TOTAL | 2703 | 1394 | 334 | 1643 | 2454 | 920 | 451 | 94.05185132209917 | false |
| C4-baseline-plus-taker-flow | 0 | 252 | 97 | 14 | 169 | 235 | 91 | 56 | 110.14319701469324 | false |
| C4-baseline-plus-taker-flow | 1 | 265 | 153 | 45 | 157 | 248 | 96 | 50 | 134.41258803985633 | false |
| C4-baseline-plus-taker-flow | 2 | 380 | 265 | 50 | 165 | 317 | 130 | 54 | 118.9197742798703 | false |
| C4-baseline-plus-taker-flow | 3 | 503 | 416 | 132 | 219 | 479 | 141 | 57 | 130.88257333581296 | false |
| C4-baseline-plus-taker-flow | 4 | 395 | 93 | 30 | 332 | 400 | 141 | 67 | 145.28204115276515 | false |
| C4-baseline-plus-taker-flow | 5 | 81 | 8 | 6 | 79 | 87 | 45 | 37 | 125.19162395901199 | false |
| C4-baseline-plus-taker-flow | 6 | 25 | 2 | 1 | 24 | 25 | 11 | 11 | 106.26344705594632 | false |
| C4-baseline-plus-taker-flow | 7 | 115 | 29 | 1 | 87 | 103 | 39 | 37 | 130.65157891931997 | false |
| C4-baseline-plus-taker-flow | 8 | 382 | 271 | 75 | 186 | 359 | 120 | 56 | 108.66873636648388 | false |
| C4-baseline-plus-taker-flow | 9 | 214 | 51 | 14 | 177 | 211 | 83 | 44 | 128.22978850849046 | false |
| C4-baseline-plus-taker-flow | 10 | 91 | 26 | 1 | 66 | 75 | 44 | 37 | 121.58631268267061 | false |
| C4-baseline-plus-taker-flow | TOTAL | 2703 | 1411 | 369 | 1661 | 2539 | 941 | 506 | 129.4572911020236 | false |
| C5-funding-plus-open-interest | 0 | 252 | 138 | 20 | 134 | 208 | 62 | 45 | 92.27764952768239 | false |
| C5-funding-plus-open-interest | 1 | 265 | 151 | 41 | 155 | 243 | 93 | 50 | 73.30351204953662 | false |
| C5-funding-plus-open-interest | 2 | 380 | 164 | 33 | 249 | 365 | 141 | 62 | 68.26597863252711 | false |
| C5-funding-plus-open-interest | 3 | 503 | 322 | 98 | 279 | 489 | 137 | 46 | 96.16052944089309 | false |
| C5-funding-plus-open-interest | 4 | 395 | 70 | 17 | 342 | 388 | 130 | 73 | 84.43332693339694 | false |
| C5-funding-plus-open-interest | 5 | 81 | 2 | 2 | 81 | 83 | 40 | 38 | 102.35920641179173 | false |
| C5-funding-plus-open-interest | 6 | 25 | 1 | 1 | 25 | 26 | 12 | 12 | 139.66600470908028 | false |
| C5-funding-plus-open-interest | 7 | 115 | 26 | 5 | 94 | 113 | 47 | 35 | 96.01907271116497 | false |
| C5-funding-plus-open-interest | 8 | 382 | 228 | 38 | 192 | 348 | 119 | 58 | 75.94259972174355 | false |
| C5-funding-plus-open-interest | 9 | 214 | 115 | 52 | 151 | 245 | 104 | 46 | 85.87685755174697 | false |
| C5-funding-plus-open-interest | 10 | 91 | 43 | 8 | 56 | 79 | 37 | 26 | 83.6448879140089 | false |
| C5-funding-plus-open-interest | TOTAL | 2703 | 1260 | 315 | 1758 | 2587 | 922 | 489 | 97.7087500537366 | false |
| C6-open-interest-plus-taker-flow | 0 | 252 | 106 | 19 | 165 | 224 | 76 | 49 | 124.48028994348402 | false |
| C6-open-interest-plus-taker-flow | 1 | 265 | 145 | 41 | 161 | 240 | 89 | 53 | 122.81641179865389 | false |
| C6-open-interest-plus-taker-flow | 2 | 380 | 250 | 63 | 193 | 356 | 139 | 67 | 103.30163549939084 | false |
| C6-open-interest-plus-taker-flow | 3 | 503 | 427 | 151 | 227 | 502 | 141 | 62 | 149.37606921660384 | false |
| C6-open-interest-plus-taker-flow | 4 | 395 | 67 | 22 | 350 | 397 | 131 | 83 | 148.80780774161235 | false |
| C6-open-interest-plus-taker-flow | 5 | 81 | 4 | 3 | 80 | 84 | 42 | 36 | 152.95504237356536 | false |
| C6-open-interest-plus-taker-flow | 6 | 25 | 1 | 1 | 25 | 26 | 12 | 12 | 188.08387150520522 | false |
| C6-open-interest-plus-taker-flow | 7 | 115 | 44 | 3 | 74 | 87 | 40 | 36 | 169.6724064824425 | false |
| C6-open-interest-plus-taker-flow | 8 | 382 | 298 | 74 | 158 | 331 | 116 | 64 | 110.83380332710752 | false |
| C6-open-interest-plus-taker-flow | 9 | 214 | 36 | 7 | 185 | 211 | 75 | 60 | 134.87625796511725 | false |
| C6-open-interest-plus-taker-flow | 10 | 91 | 22 | 1 | 70 | 89 | 46 | 37 | 125.65322959856587 | false |
| C6-open-interest-plus-taker-flow | TOTAL | 2703 | 1400 | 385 | 1688 | 2547 | 907 | 559 | 150.85093729607686 | false |
| C7-funding-plus-basis-premium | 0 | 252 | 104 | 24 | 172 | 229 | 84 | 53 | 114.68362963679111 | false |
| C7-funding-plus-basis-premium | 1 | 265 | 192 | 56 | 129 | 246 | 90 | 43 | 81.9969178867496 | false |
| C7-funding-plus-basis-premium | 2 | 380 | 192 | 49 | 237 | 360 | 134 | 64 | 68.75169388368326 | false |
| C7-funding-plus-basis-premium | 3 | 503 | 296 | 82 | 289 | 478 | 129 | 51 | 86.85762721932035 | false |
| C7-funding-plus-basis-premium | 4 | 395 | 141 | 36 | 290 | 398 | 158 | 46 | 76.50554182223969 | false |
| C7-funding-plus-basis-premium | 5 | 81 | 5 | 1 | 77 | 80 | 39 | 35 | 82.75443215297992 | false |
| C7-funding-plus-basis-premium | 6 | 25 | 4 | 0 | 21 | 22 | 9 | 7 | 98.96078921181402 | false |
| C7-funding-plus-basis-premium | 7 | 115 | 30 | 11 | 96 | 112 | 45 | 37 | 79.37247549226318 | false |
| C7-funding-plus-basis-premium | 8 | 382 | 123 | 39 | 298 | 388 | 148 | 65 | 104.26871315305145 | false |
| C7-funding-plus-basis-premium | 9 | 214 | 169 | 67 | 112 | 240 | 94 | 39 | 98.46549764528933 | false |
| C7-funding-plus-basis-premium | 10 | 91 | 38 | 10 | 63 | 85 | 43 | 32 | 91.92646756071325 | false |
| C7-funding-plus-basis-premium | TOTAL | 2703 | 1294 | 375 | 1784 | 2638 | 973 | 470 | 95.33081247700959 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 0 | 252 | 118 | 21 | 155 | 218 | 73 | 50 | 108.8777398099751 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 1 | 265 | 154 | 49 | 160 | 248 | 91 | 54 | 107.14258390253596 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 2 | 380 | 208 | 50 | 222 | 381 | 138 | 66 | 78.12719449656444 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 3 | 503 | 382 | 128 | 249 | 486 | 143 | 60 | 117.40024689265803 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 4 | 395 | 69 | 21 | 347 | 392 | 125 | 83 | 128.15412748113593 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 5 | 81 | 3 | 2 | 80 | 83 | 41 | 37 | 133.54304238266803 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 6 | 25 | 1 | 1 | 25 | 26 | 12 | 12 | 157.83483927520842 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 7 | 115 | 35 | 4 | 84 | 105 | 41 | 37 | 131.46527022742276 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 8 | 382 | 270 | 69 | 181 | 372 | 120 | 58 | 88.87255436331421 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 9 | 214 | 52 | 20 | 182 | 226 | 87 | 59 | 107.25431542068829 | false |
| C8-funding-plus-open-interest-plus-taker-flow | 10 | 91 | 25 | 2 | 68 | 86 | 42 | 37 | 105.2480562454574 | false |
| C8-funding-plus-open-interest-plus-taker-flow | TOTAL | 2703 | 1317 | 367 | 1753 | 2623 | 913 | 553 | 122.4009290933559 | false |
| C9-all-admitted-independent-families | 0 | 252 | 122 | 28 | 158 | 229 | 81 | 50 | 122.08310654578386 | false |
| C9-all-admitted-independent-families | 1 | 265 | 156 | 50 | 159 | 249 | 100 | 49 | 105.81971801975791 | false |
| C9-all-admitted-independent-families | 2 | 380 | 253 | 70 | 197 | 375 | 143 | 62 | 79.63658393760684 | false |
| C9-all-admitted-independent-families | 3 | 503 | 398 | 139 | 244 | 483 | 145 | 60 | 116.64297766245528 | false |
| C9-all-admitted-independent-families | 4 | 395 | 79 | 28 | 344 | 400 | 141 | 73 | 126.42456367352874 | false |
| C9-all-admitted-independent-families | 5 | 81 | 3 | 2 | 80 | 83 | 41 | 39 | 129.48803027880325 | false |
| C9-all-admitted-independent-families | 6 | 25 | 1 | 0 | 24 | 24 | 10 | 10 | 152.1901972732717 | false |
| C9-all-admitted-independent-families | 7 | 115 | 29 | 5 | 91 | 109 | 42 | 38 | 122.09821118347023 | false |
| C9-all-admitted-independent-families | 8 | 382 | 240 | 63 | 205 | 382 | 132 | 68 | 82.27242771083586 | false |
| C9-all-admitted-independent-families | 9 | 214 | 56 | 17 | 175 | 218 | 89 | 57 | 106.32333903983444 | false |
| C9-all-admitted-independent-families | 10 | 91 | 28 | 3 | 66 | 88 | 44 | 37 | 99.4468699943126 | false |
| C9-all-admitted-independent-families | TOTAL | 2703 | 1365 | 405 | 1743 | 2640 | 968 | 543 | 120.24486374267845 | false |

- `INTEGRATION_NO_OP=true` means admitted feature variation had no observed decision effect; it is not treated as evidence that the family lacks predictive information.

## Information-family ablation

| Family | Candidate IDs | Best candidate | Gain gate |
|---|---|---|---:|
| Funding | C1-baseline-plus-funding, C5-funding-plus-open-interest, C7-funding-plus-basis-premium, C8-funding-plus-open-interest-plus-taker-flow, C9-all-admitted-independent-families | C7-funding-plus-basis-premium | false |
| Open Interest | C2-baseline-plus-open-interest, C5-funding-plus-open-interest, C6-open-interest-plus-taker-flow, C8-funding-plus-open-interest-plus-taker-flow, C9-all-admitted-independent-families | C6-open-interest-plus-taker-flow | false |
| Basis/Premium | C3-baseline-plus-basis-premium, C7-funding-plus-basis-premium, C9-all-admitted-independent-families | C7-funding-plus-basis-premium | false |
| Taker Flow | C4-baseline-plus-taker-flow, C6-open-interest-plus-taker-flow, C8-funding-plus-open-interest-plus-taker-flow, C9-all-admitted-independent-families | C6-open-interest-plus-taker-flow | false |

### Direction ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| BUY | 7511 | 828 | 354 | 354 | 1.239 | 0.212081% | CALIBRATION_FAIL |
| SELL | 7909 | 466 | 242 | 242 | 0.5794 | -0.545644% | CALIBRATION_FAIL |

### Trend regime ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Bull | 6490 | 804 | 339 | 339 | 1.2965 | 0.259377% | CALIBRATION_FAIL |
| Bear | 7005 | 435 | 219 | 219 | 0.5413 | -0.627938% | CALIBRATION_FAIL |
| Sideways | 1925 | 55 | 38 | 37 | 0.7668 | -0.194203% | CALIBRATION_FAIL |

### Volatility regime ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Low | 3226 | 296 | 141 | 138 | 0.8922 | -0.168805% | CALIBRATION_FAIL |
| Normal | 4294 | 442 | 202 | 197 | 0.7148 | -0.092359% | CALIBRATION_FAIL |
| High | 4194 | 0 | 0 | 0 | N/A | N/A | CALIBRATION_FAIL |
| Extreme | 3706 | 556 | 253 | 247 | 0.9576 | -0.057357% | CALIBRATION_FAIL |

### Setup-family ablation

| Slice | Candidates | Eligible | Selected | Clusters | Net PF | Net expectancy | Calibration |
|---|---:|---:|---:|---:|---:|---:|---|
| Trend Continuation | 11012 | 984 | 440 | 426 | 0.8409 | -0.167238% | CALIBRATION_FAIL |
| Mean Reversion | 1328 | 36 | 27 | 27 | 1.069 | 0.045739% | CALIBRATION_FAIL |
| Breakout | 3080 | 274 | 129 | 129 | 1.1043 | 0.119227% | CALIBRATION_FAIL |

## Required failure-mode checks

- BUY/SELL slices are retained: {"BUY":{"sample_count":491,"evaluated_count":491,"net_expectancy_percent":0.049342,"gross_expectancy_percent":0.189342,"net_profit_factor":1.0415,"gross_profit_factor":1.1702,"hit_rate_percent":41.3442,"false_positive_rate_percent":58.6558,"avg_mfe_percent":5.762986,"avg_mae_percent":-4.080548,"tp_first_count":193,"sl_first_count":294,"neither_count":0,"ambiguous_count":4,"tp_first_rate_percent":39.3075,"sl_first_rate_percent":59.8778,"conservative_sl_first_count":298},"SELL":{"sample_count":372,"evaluated_count":372,"net_expectancy_percent":-0.279267,"gross_expectancy_percent":-0.139267,"net_profit_factor":0.7445,"gross_profit_factor":0.8633,"hit_rate_percent":42.2043,"false_positive_rate_percent":57.7957,"avg_mfe_percent":3.585932,"avg_mae_percent":-3.666133,"tp_first_count":153,"sl_first_count":217,"neither_count":0,"ambiguous_count":2,"tp_first_rate_percent":41.129,"sl_first_rate_percent":58.3333,"conservative_sl_first_count":219}}
- Sideways/Mean Reversion diagnosis: **C_HISTORICAL_MARKET_LACKED_VALID_SIDEWAYS_SELECTION**
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
- Augmented concentration: {"independent_cluster_count":574,"symbol":{"counts":{"BNBUSDT":111,"AAVEUSDT":54,"ARBUSDT":54,"APTUSDT":49,"ATOMUSDT":45,"NEARUSDT":40,"IMXUSDT":39,"ADAUSDT":36,"AVAXUSDT":29,"UNIUSDT":29,"STXUSDT":27,"DOTUSDT":15,"ETHUSDT":13,"LINKUSDT":13,"BTCUSDT":10,"SOLUSDT":6,"XRPUSDT":4},"max_share":0.19338,"max_key":"BNBUSDT"},"regime":{"counts":{"Bull":327,"Bear":213,"Sideways":34},"max_share":0.569686,"max_key":"Bull"},"direction":{"counts":{"BUY":342,"SELL":232},"max_share":0.595819,"max_key":"BUY"},"setup":{"counts":{"Trend Continuation":423,"Breakout":128,"Mean Reversion":23},"max_share":0.736934,"max_key":"Trend Continuation"},"max_symbol_cluster_share":0.19338,"max_regime_cluster_share":0.569686,"max_direction_cluster_share":0.595819,"max_setup_cluster_share":0.736934,"record_level":{"symbol":{"NEARUSDT":42,"AVAXUSDT":31,"BNBUSDT":116,"STXUSDT":28,"AAVEUSDT":54,"IMXUSDT":44,"XRPUSDT":4,"ADAUSDT":37,"DOTUSDT":16,"ARBUSDT":54,"UNIUSDT":30,"ATOMUSDT":46,"APTUSDT":50,"ETHUSDT":13,"LINKUSDT":14,"LTCUSDT":1,"BTCUSDT":10,"SOLUSDT":6},"regime":{"Bull":339,"Bear":219,"Sideways":38},"direction":{"BUY":354,"SELL":242},"setup":{"Trend Continuation":440,"Breakout":129,"Mean Reversion":27},"selected_records":596}}
- Final holdout: {"count":6301,"start":1783861199999,"hash":"294e6cecb24eeb4ac5041d0bba74e0e0e04301092c13e0c454d862dcaafd40bb","untouched":true,"outcomes_accessed_for_selection":false}

## Decision and limitations

- Information-gain decision: **NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN**
- Known limitations: ["This bounded run targets 180d and the configured 18-symbol universe; no symbols were blacklisted by result.","Only public Binance Vision archives were admitted. Liquidations were not admitted and no historical order-book proxy was used.","Open-interest metrics were reduced to the latest source row per UTC hour for memory-bounded, conservative PIT lookup.","All candidate normalization, train scalers, signs, thresholds and combination rules are fit inside each WFO training window.","The old M1 final holdout was filtered before labels were read; the new WFO final holdout was not used for selection.","Cost sensitivity at 0.10%, 0.14% and 0.20% is diagnostic only and cannot change the decision.","Information-gain comparisons resample independent market-event clusters with deterministic bootstrap settings."]

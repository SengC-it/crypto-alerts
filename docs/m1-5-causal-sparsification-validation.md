# M1.5 — Causal Signal Sparsification Independent Temporal Validation

- Research version: m1.5-causal-sparsification-0.1.0
- Experiment ID: m1.5-public_binance_futures-2026-07-12_to_2026-09-07-causal-sparsification-0.1.0
- Decision: SPARSIFICATION_NOT_CONFIRMED
- Official performance runs: 1
- Production deployment: false
- M2 started: false

## Frozen lineage

- Base main SHA: 748e41815948ca5cd7b9016738a593b760e5d6ad
- M1.4 source SHA: 859ea3ba69bf7df89cb6f2fe34ebd9fd0dd1ac8d
- Experiment source SHA: 49edecc
- Config hash: a3332001fde1e1d66035d742ff569d0ee34f1599984507b8623951622cba4c64
- Validation data manifest hash: 29f8135aaf70ad2ff0b3f7a280eeab1b14b81b7345690393751874f1a82f012d
- Outcome data manifest hash: e3246f922905da361d9ee8e359b373e8a2a6108bd5f77d0ed72c36830e24cd6f

## Fixed validation contract

- Signal range: 2026-07-12T12:59:59.999Z through 2026-09-07T15:59:59.999Z
- Outcome data end: 2026-09-07T23:59:59.999Z
- Candidate: X8-btc-eth-lead-lag-continuation
- Horizon: 8h
- Net round-trip cost: 0.14%
- Causal bucket-close breadth floor: 12
- Contiguous windows: 8 (plan hash 342d0d8fca4eda7803619157c6da68d1e608805680b7c245e092ddd36034634a)
- Standard bootstrap: 5000 reps, seed 20260909
- Moving block bootstrap: 3 events / 12h

## C1 result

| Metric | Value |
| --- | ---: |
| Independent events | 343 |
| Net expectancy | -0.21845153% |
| Net profit factor | 0.792083 |
| Net positive windows | 2/8 |
| Standard net CI95 | [-0.43614056,-0.01195955] |
| Standard P(mean > 0) | 0.0176 |
| Moving-block net CI95 | [-0.45729401,-0.01359777] |
| Moving-block P(mean > 0) | 0.0186 |
| Calibration | CALIBRATION_FAIL |
| C1 confirmation gate | false |
| Absolute promotion gate | false |

## Policy gates

| Policy | Pass | Deployable | Secondary only |
| --- | --- | --- | --- |
| RETROSPECTIVE_TOP1_PER_4H_EVENT_PER_DIRECTION | false | false | false |
| RETROSPECTIVE_TOP1_PER_4H_EVENT_TOTAL | false | false | false |
| CAUSAL_BUCKET_CLOSE_TOP1_PER_DIRECTION | false | false | false |
| CAUSAL_BUCKET_CLOSE_TOP1_TOTAL | false | false | true |

## Validation windows

| Index | Events | Event start | Event end |
| ---: | ---: | --- | --- |
| 0 | 43 | m13-4h:1783857600000 | m13-4h:1784462400000 |
| 1 | 43 | m13-4h:1784476800000 | m13-4h:1785081600000 |
| 2 | 43 | m13-4h:1785096000000 | m13-4h:1785700800000 |
| 3 | 43 | m13-4h:1785715200000 | m13-4h:1786320000000 |
| 4 | 43 | m13-4h:1786334400000 | m13-4h:1786939200000 |
| 5 | 43 | m13-4h:1786953600000 | m13-4h:1787558400000 |
| 6 | 43 | m13-4h:1787572800000 | m13-4h:1788177600000 |
| 7 | 42 | m13-4h:1788192000000 | m13-4h:1788782400000 |

The causality gap and discovery-retention delta are diagnostics only. No symbol, direction, regime, threshold, or horizon filter was introduced, and no production route was changed.

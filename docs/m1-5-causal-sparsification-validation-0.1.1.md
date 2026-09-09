# M1.5 — Causal Signal Sparsification Independent Temporal Validation

- Research version: m1.5-causal-sparsification-0.1.1
- Experiment ID: m1.5-public_binance_futures-2026-07-12_to_2026-09-07-causal-sparsification-0.1.1
- Decision: SPARSIFICATION_NOT_CONFIRMED
- Official performance runs: 1
- Production deployment: false
- M2 started: false

## Frozen lineage

- Base main SHA: 748e41815948ca5cd7b9016738a593b760e5d6ad
- M1.4 source SHA: 859ea3ba69bf7df89cb6f2fe34ebd9fd0dd1ac8d
- Experiment source SHA: b8b9c2bd5f7b76273f37b1ce0d3c33de8c3b7db3
- Supersedes: m1.5-causal-sparsification-0.1.0 (RETROSPECTIVE_EVENT_WINDOW_ASSIGNMENT_METHOD_ERROR)
- Prior run status: INVALIDATED_METHOD_ERROR
- Config hash: abb9ebc7c3fa6fd9ad0aee1482f3c10c50cf7fb693a78c59798c69bef169b275
- Validation data manifest hash: 4e95241a2fc12a9a2e6c19e471a083833a69d1440aa005c0959eba123d0881d0
- Outcome data manifest hash: bc750441f3a6b0d060e1ee08c6bd6fcaf1e95ac6ebd52431d1cb878382eaa08d

## Fixed validation contract

- Signal range: 2026-07-12T12:59:59.999Z through 2026-09-07T15:59:59.999Z
- Outcome data end: 2026-09-07T23:59:59.999Z
- Candidate: X8-btc-eth-lead-lag-continuation
- Horizon: 8h
- Net round-trip cost: 0.14%
- Causal bucket-close breadth floor: 12
- Contiguous windows: 8 (plan hash 1014d326a1ef42c338122aec1da526ca001889266cc391284fcaf271e79089e1)
- Event-window map hash: cacec44410b68bcf1911c1ed4f95792c46d9b4ae265362f936979b6e572d30b8
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
| CAUSAL_BUCKET_CLOSE_TOP1_PER_DIRECTION | false | true | false |
| CAUSAL_BUCKET_CLOSE_TOP1_TOTAL | false | true | true |

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

# M1.4 Alpha Feasibility & Signal Utility Review

Decision: **DIRECTIONAL_RESEARCH_CONTINUE**

- Base main SHA: `80f46614ee1db025ffd3c76a71ad5fb7e663bfe5`; experiment source SHA: `859ea3ba69bf7df89cb6f2fe34ebd9fd0dd1ac8d`.
- Review version: `m1.4-alpha-feasibility-0.1.1`; experiment: `m1.4-public_binance_futures_archive-2026-07-12-m1.4-alpha-feasibility-0.1.1`.
- Data: public_binance_futures_archive; 365d target; 365d accepted × 18 configured symbols.
- Final holdout untouched: **true**; outcomes accessed: **false**.

## Frozen review lanes

| Lane | Role | Primary horizon | Signals | Events | Gross expectancy | Net expectancy | Gross PF | Net PF | Classification |
|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| R0 | V1 production/frozen baseline | 1 | 0 | 0 | N/A% | N/A% | 0 | 0 | NO_GROSS_DIRECTIONAL_EDGE |
| R1 | M1.1 frozen final diagnostic lane | record_primary | 1318 | 534 | -0.00762308% | -0.14762308% | 0.990584 | 0.833379 | NO_GROSS_DIRECTIONAL_EDGE |
| R2 | M1.2 frozen final diagnostic lane | record_primary | 1050 | 438 | -0.17564361% | -0.31564361% | 0.79293 | 0.659981 | NO_GROSS_DIRECTIONAL_EDGE |
| R3 | M1.3 X8 BTC/ETH lead-lag continuation | 4 | 7696 | 962 | 0.0358241% | -0.1041759% | 1.058091 | 0.848706 | NO_GROSS_DIRECTIONAL_EDGE |

## Density feasibility

- Frozen-lane robust gross edge: **false**.
- Any density robust gross edge: **true**.

| Density view | Gross expectancy | Net expectancy | Gross PF | Net PF | Gross positive windows | Net positive windows | Events | Unique concentration | Gross CI95 | P(gross > 0) | Robust gross |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---:|---|
| RAW_1H_SIGNAL_STREAM | 0% | -0.14% | 1 | 0.838923 | 0/0 | 0/0 | 962 | 1 | [0,0] | 0 | false |
| TOP1_PER_4H_EVENT_PER_DIRECTION | 0.38239275% | 0.24239275% | 1.473203 | 1.27784 | 8/1 | 8/1 | 962 | 0.28586279 | [0.29125062,0.47258423] | 1 | true |
| TOP1_PER_4H_EVENT_TOTAL | 0.28082718% | 0.14082718% | 1.303627 | 1.142089 | 6/0.75 | 6/0.75 | 962 | 0.17463617 | [0.09837102,0.48397105] | 0.9985 | true |

## Calendar parity

```json
{
  "canonical_review_plan_hash": "6356ff210f4b8069d440e3197556854ff3f801e9eec3d310d5e5f8750891653c",
  "same_train_windows": true,
  "same_oos_windows": true,
  "same_purge": true,
  "same_embargo": true,
  "same_final_holdout_boundary": true,
  "canonical_wfo_plan_hash": "a00c714e4a3910a09c4707cb0de910e593294ffd91272f791c7316fc7c2ac243",
  "canonical_wfo_window_count": 8,
  "final_holdout_outcomes_accessed": false
}
```

## Event alert utility

```json
{
  "primary_horizon_hours": 8,
  "gate": "EVENT_ALERT_UTILITY_GATE",
  "pass": false,
  "independent_events": 962,
  "delta_8h_absolute_return": 0.25004553,
  "delta_8h_ci95": [
    0.21376041,
    0.28775761
  ],
  "p_delta_gt_zero": 1,
  "positive_windows": 8,
  "oos_windows": 8,
  "positive_window_ratio": 1,
  "symbol_breadth": 18,
  "max_symbol_event_concentration": 0.50727651,
  "bootstrap": {
    "unit": "independent_market_event_id",
    "repetitions": 2000,
    "seed": 20260908,
    "event_count": 962
  },
  "failure_reasons": [
    "concentration"
  ],
  "secondary_horizons": {
    "4h": {
      "event_count": 962,
      "delta_8h_absolute_return": 0.19129311,
      "delta_8h_ci95": [
        0.16370875,
        0.21621354
      ],
      "p_delta_gt_zero": 1,
      "positive_windows": 8,
      "oos_windows": 8,
      "positive_window_ratio": 1,
      "symbol_breadth": 18,
      "max_symbol_event_concentration": 0.50727651,
      "bootstrap": {
        "unit": "independent_market_event_id",
        "repetitions": 2000,
        "seed": 20260908,
        "event_count": 962
      },
      "gate_pass": false,
      "gate_failures": [
        "concentration"
      ]
    },
    "24h": {
      "event_count": 962,
      "delta_8h_absolute_return": 0.4115928,
      "delta_8h_ci95": [
        0.34338681,
        0.48531153
      ],
      "p_delta_gt_zero": 1,
      "positive_windows": 8,
      "oos_windows": 8,
      "positive_window_ratio": 1,
      "symbol_breadth": 18,
      "max_symbol_event_concentration": 0.50727651,
      "bootstrap": {
        "unit": "independent_market_event_id",
        "repetitions": 2000,
        "seed": 20260908,
        "event_count": 962
      },
      "gate_pass": false,
      "gate_failures": [
        "concentration"
      ]
    }
  },
  "event_values": {
    "count": 962,
    "ids_hash": "83d2e27021eb58343e61238660724b3603e688bff810677c5c81ffb14942b88e",
    "values_hash": "7413877bf3756cccd7488af9883d6702c5c069463c11f0cc67e182a6a50a3b19"
  },
  "same_timestamp_outcome_independent": true,
  "trading_profitability_claim": false
}
```

## Feasibility matrix

| Dimension | Result | Evidence | Implication |
|---|---|---|---|
| Frozen-lane robust gross edge | false | 4 frozen lanes at their declared primary horizons | No frozen lane alone justifies continuation unless this passes |
| Density robust gross edge | true | Three predeclared density diagnostics at fixed 8h | Feasibility signal only; no density promotion |
| Directional research signal | true | Frozen-lane OR density robust gross gate | At most one separately designed future validation stage |
| Directional net edge | false | Fixed 0.14% gate and existing promotion criteria | No production promotion |
| Cost sensitivity | NO_GROSS_DIRECTIONAL_EDGE | R3 4h primary gross=0.0358241% net=-0.1041759% | Diagnostic only; no cost-based retuning |
| Horizon stability | UNSTABLE | R3 1/4/8/12/24/48h surface | Descriptive only |
| Signal density | DIAGNOSTIC_ONLY | Three predeclared density views | No density policy deployment |
| BUY quality | -0.27991614 | R3 BUY OOS slice | BUY remains enabled for research/alerts |
| SELL quality | 0.0920711 | R3 SELL OOS slice | SELL remains enabled for research/alerts |
| Universe robustness | DIAGNOSTIC_ONLY | Tier1/Tier2/Tier3/Tier1+Tier2/All18 | No whitelist or symbol removal |
| Regime robustness | DIAGNOSTIC_ONLY | Bull/Bear/Sideways and Low/Normal/High/Extreme | No regime production rule |
| Score calibration | CALIBRATION_FAIL | Frozen OOS score bins | No probability interpretation |
| Microstructure value | NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN | M1.2 complete candidate distribution | No derivative alpha expansion |
| Cross-sectional value | NO_ROBUST_CROSS_SECTIONAL_ALPHA | M1.3 complete X0-X11 distribution | No new cross-sectional candidates |
| Event/magnitude alert value | false | 8h delta=0.25004553; CI=[0.21376041,0.28775761] | Keep monitoring/research platform without event-utility claim |
| Public-data limitation | TESTED_PUBLIC_BINANCE_DATA_ONLY | Closed 1h candles, 18 configured symbols | Absence of demonstrated edge is protocol-bounded, not impossibility proof |
| Final holdout status | true | Boundary/hash metadata only | No holdout selection or conclusion leakage |

## Known limitations

- M1.1 and M1.2 lanes retain their frozen semantics and are diagnostic representatives; they are not new promotion candidates.
- All comparable lanes use one outcome-independent calendar with 48h purge, 24h embargo and the frozen final-holdout boundary.
- The event-alert comparator uses only same-timestamp valid configured symbols and evaluates future absolute movement after support is fixed; it does not claim trading profitability.
- Cost, horizon, density, tier, direction, regime and IC surfaces are diagnostic only and cannot create, retune or disable a signal lane.
- The review uses closed public Binance Futures 1h candles and the configured 18-symbol universe; it does not establish impossibility outside these tested public-data families.
- The final holdout is retained as boundary/hash/count metadata only; no holdout outcomes enter selection, metrics, event utility or the project decision.

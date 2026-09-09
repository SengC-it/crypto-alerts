# M1.4 Alpha Feasibility & Signal Utility Review

Decision: **STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM**

- Base main SHA: `80f46614ee1db025ffd3c76a71ad5fb7e663bfe5`; experiment source SHA: `8709b496cc6987e7752e02c862a0218adca8e0fd`.
- Review version: `m1.4-alpha-feasibility-0.1.0`; experiment: `m1.4-public_binance_futures_archive-2026-07-12-m1.4-alpha-feasibility-0.1.0`.
- Data: public_binance_futures_archive; 365d target; 365d accepted × 18 configured symbols.
- Final holdout untouched: **true**; outcomes accessed: **false**.

## Frozen review lanes

| Lane | Role | Signals | Events | Gross expectancy | Net expectancy | Gross PF | Net PF | Classification |
|---|---|---:|---:|---:|---:|---:|---:|---|
| R0 | V1 production/frozen baseline | 0 | 0 | N/A% | N/A% | 0 | 0 | NO_GROSS_DIRECTIONAL_EDGE |
| R1 | M1.1 frozen final diagnostic lane | 1318 | 534 | -0.0018833% | -0.1418833% | 0.997956 | 0.857799 | NO_GROSS_DIRECTIONAL_EDGE |
| R2 | M1.2 frozen final diagnostic lane | 1050 | 438 | -0.07353892% | -0.21353892% | 0.916012 | 0.775648 | NO_GROSS_DIRECTIONAL_EDGE |
| R3 | M1.3 X8 BTC/ETH lead-lag continuation | 7696 | 962 | 0.04607748% | -0.09392252% | 1.051691 | 0.902472 | NO_GROSS_DIRECTIONAL_EDGE |

## Calendar parity

```json
{
  "canonical_review_plan_hash": "9b0e072448f402f29921a0c8d532f620ba81f3d4ae42d974d314ffad010b7378",
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
| Directional gross edge | false | 4 frozen lanes; robust WFO gross gate | Directional research is not continued unless a frozen lane passes robustness |
| Directional net edge | false | Fixed 0.14% gate and existing promotion criteria | No production promotion |
| Cost sensitivity | NO_GROSS_DIRECTIONAL_EDGE | R3 8h gross=0.04607748% net=-0.09392252% | Diagnostic only; no cost-based retuning |
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

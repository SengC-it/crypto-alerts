# M1.6 — Project-Level Profitability Feasibility Review

- Base main SHA: `6361418a35e3d8f7e5aa1c6e5ce87bfb38830a2a`
- Source SHA: `UNCOMMITTED`
- Decision: `STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM`
- Scope: accepted research evidence only; no alpha search, deployment, V2 enablement, or M2.

## Accepted evidence ledger

| Stage | Primary OOS events | Gross exp % | Net exp % | Gross PF | Net PF | Positive windows | Calibration | Promotion | Decision |
|---|---:|---:|---:|---:|---:|---|---|---|---|
| M1 | 164 | -0.062178 | -0.202178 | — | 0.4533 | 1/10 | CALIBRATION_FAIL | REJECT | REJECT |
| M1.1 | 822 | 0.047694 | -0.092306 | 1.0445 | 0.9196 | 4/11 | CALIBRATION_FAIL | REJECT | NO_ROBUST_EDGE_FOUND |
| M1.2 | 822 | 0.047694 | -0.092306 | 1.0445 | 0.9196 | 4/11 | CALIBRATION_FAIL | REJECT | NO_ROBUST_MICROSTRUCTURE_INFORMATION_GAIN |
| M1.3 | 962 | 0.0358241 | -0.1041759 | 1.058091 | 0.848706 | 0/0 | NOT_REPORTED | REJECT | NO_ROBUST_CROSS_SECTIONAL_ALPHA |
| M1.4 | 962 | 0.0358241 | -0.1041759 | 1.058091 | 0.848706 | 0/8 | CALIBRATION_FAIL | REJECT | DIRECTIONAL_RESEARCH_CONTINUE |
| M1.5 | 343 | -0.07845153 | -0.21845153 | 0.920176 | 0.792083 | 2/8 | CALIBRATION_FAIL | REJECT | SPARSIFICATION_NOT_CONFIRMED |

Only the accepted final artifacts are included. The invalidated M1.5 0.1.0 run is excluded; final holdout outcomes were not opened.

## Failure taxonomy

- **A. NO_PREDICTIVE_INFORMATION** — MODERATE; Repeated rejected OOS lanes; not an impossibility claim. (stages: M1, M1.1, M1.2, M1.3, M1.5).
- **B. GROSS_EDGE_TOO_WEAK_FOR_COST** — STRONG; Positive gross lanes remain below fixed 0.14% cost or have no positive gross edge. (stages: M1.1, M1.2, M1.3, M1.4, M1.5).
- **C. NON_STATIONARY_EDGE** — STRONG; Unstable windows and fresh confirmation decay. (stages: M1.1, M1.3, M1.4, M1.5).
- **D. DIRECTIONAL_ASYMMETRY** — MODERATE; Observed slices are diagnostic; no predeclared replicated BUY-only rule. (stages: M1, M1.1, M1.5).
- **E. SIGNAL_DENSITY_CORRELATION** — MODERATE; Retrospective density view differs from raw stream and causal view. (stages: M1.4, M1.5).
- **F. SCORE_CALIBRATION_FAILURE** — STRONG; Accepted primary lanes repeatedly report CALIBRATION_FAIL. (stages: M1, M1.1, M1.2, M1.3, M1.5).
- **G. SYMBOL_CONCENTRATION** — STRONG; Concentration gates fail or diagnostic lanes exceed the 0.30 threshold. (stages: M1.3, M1.4, M1.5).
- **H. REGIME_CONCENTRATION** — WEAK; Bull/Bear shares are imbalanced but not the primary hard failure. (stages: M1.1, M1.2).
- **I. CAUSAL_TRANSLATION_FAILURE** — STRONG; M1.4 retrospective density result does not survive corrected causal fresh validation. (stages: M1.4, M1.5).
- **J. DATA_DOMAIN_LIMITATION** — MODERATE; Only public 1h/derivative aggregates were accepted; missing domains are not asserted to contain alpha. (stages: M1, M1.1, M1.2, M1.3, M1.4, M1.5).

## Cost and stability conclusions

Fixed research cost remains 0.14%. Break-even cost is the gross mean expectancy; no cost or horizon was changed. Apparent density edge decays under fresh, causal validation; net confirmation fails.
M1.4 → M1.5 expectancy delta: -0.11611486 percentage points; PF delta: -0.143315.

## Direction, score, and information domains

Directional classification: POST_HOC_ONLY; BUY-only selection allowed: false.
Score calibration: SCORE_NOT_DECISION_GRADE.
Tested domains: 1h OHLCV, technical structure, market regime, cross-sectional ranks, relative/residual momentum, lead-lag, funding, open interest, basis/premium, taker flow.
Untested/unavailable domains: true historical order book (NOT_AVAILABLE), trade-level microstructure (PARTIALLY_AVAILABLE), liquidation flow (NOT_AVAILABLE), sub-hour event structure (NOT_AVAILABLE), external cross-market information (AVAILABLE_AND_UNTESTED). No missing domain is claimed to contain alpha.

## M1.4 event magnitude evidence

8h absolute-return enrichment: 0.25004553 percentage points; CI95 [0.21376041,0.28775761]; concentration 0.50727651; gate false. This is not directional alpha.

## Decision and boundary

**STOP_ALPHA_EXPANSION_KEEP_ALERT_PLATFORM**

Close the X8, signal sparsification, basic derivative augmentation, and current cross-sectional directional lines. Keep V1/alert-platform work scoped to product quality, alert UX, observability, data integrity, and performance monitoring.

```text
SIGNAL_ONLY=true
USER_DECIDES_ENTRY=true
USER_DECIDES_POSITION_SIZE=true
USER_DECIDES_EXIT=true
V1_UNCHANGED=true
V2_PRODUCTION_ENABLED=false
AUTO_TRADING=false
PRIVATE_TRADING_API=false
M2_STARTED=false
holdout_outcomes_opened=false
new_candidates_generated=false
production_route_changes=false
```

No deployment. No merge. No M2. Wait for independent acceptance.

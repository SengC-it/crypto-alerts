# Optimization Experiment Platform Design

## Goal

Make strategy optimization data-backed and repeatable by fixing historical data retrieval, moving fee/slippage accounting into the backtest engine, adding parameter scans, and producing machine-readable plus human-readable reports.

## Scope

This phase builds the experiment platform before changing live strategy defaults. It may add scripts, tests, and backtest options. It will not auto-trade, change notification recipients, or deploy.

## Design

Historical data fetching becomes a first-class utility in `src/backtest/historicalData.js`. It fetches Binance Futures klines in pages, retries transient failures, validates array responses, deduplicates by open time, and returns structured errors when a symbol cannot be loaded. The backtest engine consumes this utility by default but also accepts injected candles for deterministic tests.

Backtest accounting records gross PnL, round-trip cost, and net PnL per trade. Existing `pnlPercent` remains net PnL so old summaries stay conservative. Aggregate stats include gross return, fee/slippage cost, net return, net profit factor, and cost assumptions.

Parameter scanning lives in `src/backtest/optimizer.js`. It generates explicit scenario grids, runs backtests for each scenario, and ranks results by a risk-adjusted score that rewards net return, profit factor, win rate, and low drawdown. Scripts in `scripts/` expose scans and write JSON/Markdown reports under `reports/backtests/`.

## Error Handling

Backtest and scan scripts must fail loudly when no symbols produce usable data. Binance errors, timeouts, invalid payloads, and insufficient data are reported per symbol. A zero-result report is considered an infrastructure failure, not a strategy result.

## Testing

Tests cover pagination/deduplication, retry behavior, visible data errors, fee/slippage math, parameter grid generation, and report formatting. The package test script must run on current Node by explicitly targeting JavaScript test files.

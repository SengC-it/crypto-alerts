# Optimization Experiment Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reliable optimization experiment platform for historical data, fee-adjusted backtests, parameter scans, and reports.

**Architecture:** Add focused backtest utilities for historical data, optimization, and reporting. Keep live signal checking unchanged while the backtest engine gains injected data support and integrated net-cost accounting.

**Tech Stack:** Node.js ESM, node:test, Binance Futures REST, existing strategy and indicator modules.

---

### Task 1: Test Harness

**Files:**
- Modify: `package.json`
- Test: `tests/package.test.js`

- [ ] Add a test that asserts the npm test script targets `tests/*.js`.
- [ ] Run the test and verify it fails.
- [ ] Update `package.json`.
- [ ] Run the package test and full test suite.

### Task 2: Historical Data Utility

**Files:**
- Create: `src/backtest/historicalData.js`
- Modify: `src/websocket/rest.js`
- Test: `tests/historicalData.test.js`

- [ ] Add tests for paginated requests, deduplication, retries, invalid payloads, and insufficient candles.
- [ ] Run tests and verify failures.
- [ ] Implement the utility and compatible REST params.
- [ ] Run targeted and full tests.

### Task 3: Fee-Adjusted Backtest Core

**Files:**
- Modify: `src/backtest/engine.js`
- Test: `tests/backtestAccounting.test.js`

- [ ] Add tests for gross PnL, round-trip cost, net PnL, and aggregate cost stats using injected candles.
- [ ] Run tests and verify failures.
- [ ] Implement cost accounting and injected candle support.
- [ ] Run targeted and full tests.

### Task 4: Parameter Optimizer

**Files:**
- Create: `src/backtest/optimizer.js`
- Test: `tests/optimizer.test.js`

- [ ] Add tests for scenario grid generation and ranking.
- [ ] Run tests and verify failures.
- [ ] Implement grid generation, strategy config overrides, and ranking.
- [ ] Run targeted and full tests.

### Task 5: Report Output

**Files:**
- Create: `src/backtest/report.js`
- Create: `scripts/optimize-strategies.js`
- Modify: `scripts/fee-adjusted-backtest.js`
- Test: `tests/report.test.js`

- [ ] Add tests for Markdown/JSON summary shape and zero-result failure behavior.
- [ ] Run tests and verify failures.
- [ ] Implement report helpers and scan script.
- [ ] Run tests and a dry local scan command where network permits.

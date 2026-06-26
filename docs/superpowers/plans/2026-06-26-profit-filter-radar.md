# Profit Filter Radar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a data-backed profit filter so alerts favor historically stronger short-side, volume-confirmed setups and report net trade quality.

**Architecture:** Keep strategy generation unchanged, then apply a small post-strategy profit filter after the existing confidence/conflict/resonance filter. Use shared config for costs, direction, strategy exclusions, and minimum net target so live checks and backtests stay aligned.

**Tech Stack:** Node.js ES modules, built-in `node:test`, existing indicator and strategy modules.

---

### Task 1: Add Profit Filter Tests

**Files:**
- Modify: `tests/strategies.test.js`

- [ ] Add tests proving the profit filter removes excluded strategies, disallowed directions, and low net target space.
- [ ] Run `node --test tests/strategies.test.js` and verify the new tests fail because `applyProfitFilter` is not exported yet.

### Task 2: Implement Profit Filter

**Files:**
- Modify: `src/config.js`
- Modify: `src/strategies/manager.js`

- [ ] Add `CONFIG.TRADING_COSTS` with fee/slippage values matching the current fee-adjusted backtest.
- [ ] Add `CONFIG.PROFIT_FILTER` defaults: enabled, SELL-only, exclude `bollinger_mean_reversion`, minimum net target percent 1.0.
- [ ] Export `applyProfitFilter(signals, options)` from `manager.js`.
- [ ] Run `node --test tests/strategies.test.js` and verify the tests pass.

### Task 3: Wire Production and Backtest Paths

**Files:**
- Modify: `src/index.js`
- Modify: `api/lib/checker.js`
- Modify: `src/backtest/engine.js`

- [ ] Apply `applyProfitFilter` after `filterSignals` in WebSocket, serverless checker, and backtest paths.
- [ ] Deduct round-trip costs in backtest trade PnL and expose gross/net fields in trade details.
- [ ] Run full tests with `npm.cmd test`.

### Task 4: Fix Test Script and Verify

**Files:**
- Modify: `package.json`

- [ ] Change the test script to `node --test tests/*.test.js`.
- [ ] Run `npm.cmd test`.
- [ ] Run `node --test tests/*.test.js`.

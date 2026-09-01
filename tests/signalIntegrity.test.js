import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  normalizeCandle,
  filterClosedCandles,
  intervalToMs,
} from '../src/market/candle.js';
import { donchianChannel } from '../src/indicators/index.js';
import { SignalEngine } from '../src/signal/engine.js';
import { computeAllIndicators } from '../src/indicators/index.js';
import { backtestAll, backtestSymbol, evaluateBacktestCandle } from '../src/backtest/engine.js';
import {
  requestedWindow,
  buildCoverageReport,
  assertCoverage,
  loadBacktestHistory,
  CoverageError,
} from '../src/backtest/history.js';
import { getHistoricalCandles } from '../src/websocket/rest.js';
import { SignalEvaluator, directionReturnPercent } from '../src/evaluation/signalEvaluator.js';
import { runOptimizationGrid } from '../src/backtest/optimizer.js';
import { SignalStore } from '../src/db/signalStore.js';
import { persistAndNotify } from '../src/delivery.js';
import { authorizeCronRequest } from '../src/api/auth.js';
import { evaluateSymbolCandles } from '../api/lib/checker.js';
import { createIndicatorSnapshot } from '../src/indicators/provenance.js';

const HOUR = intervalToMs('1h');

function makeCandle(openTime, close, options = {}) {
  return {
    open: close,
    high: close + (options.highExtra ?? 1),
    low: close - (options.lowExtra ?? 1),
    close,
    volume: options.volume ?? 100,
    open_time: openTime,
    close_time: openTime + HOUR - 1,
    timeframe: '1h',
    is_closed: options.isClosed ?? true,
    symbol: options.symbol || 'BTCUSDT',
  };
}

function makeDonchianDataset(count = 60, start = Date.UTC(2026, 0, 1)) {
  return Array.from({ length: count }, (_, index) => {
    const close = index === count - 1 ? 200 : 100 + index * 0.2;
    return makeCandle(start + index * HOUR, close, {
      highExtra: index === count - 1 ? 0 : 1,
      lowExtra: 1,
    });
  });
}

function signalConfig() {
  return {
    INDICATOR_LOOKBACK_CANDLES: 21,
    DEFAULT_STRATEGIES: {
      donchian_breakout: { enabled: true, period: 20, channel_position_threshold: 0.9, timeframe: '1h' },
    },
    SIGNAL_FILTER: {
      minConfidence: 0,
      filterConflicts: false,
      boostResonance: false,
      buyRequiresTrendConfirm: false,
    },
    PROFIT_FILTER: { enabled: false },
    TRADING_COSTS: { roundTripPercent: 0 },
  };
}

describe('Canonical candle and closed-candle gate', () => {
  it('normalizes Binance fields and filters an unfinished REST candle', () => {
    const now = Date.UTC(2026, 0, 1, 1);
    const closed = [
      now - HOUR,
      '100',
      '105',
      '95',
      '102',
      '10',
      now - 1,
      '1000',
      '3',
      '4',
      '5',
    ];
    const open = [
      now,
      '102',
      '106',
      '101',
      '105',
      '12',
      now + HOUR - 1,
      '1000',
      '3',
      '4',
      '5',
    ];
    const normalized = normalizeCandle(closed, { symbol: 'BTCUSDT', timeframe: '1h', now });
    assert.deepEqual(
      Object.keys(normalized).slice(0, 10),
      ['open', 'high', 'low', 'close', 'volume', 'open_time', 'close_time', 'timeframe', 'is_closed', 'symbol'],
    );
    assert.equal(normalized.is_closed, true);
    assert.equal(normalized.open_time, now - HOUR);
    assert.equal(filterClosedCandles([closed, open], {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      now,
    }).length, 1);
  });

  it('refuses to generate a primary signal from the last unfinished candle', () => {
    const candles = makeDonchianDataset();
    const unfinished = { ...candles.at(-1), is_closed: false };
    const evaluation = new SignalEngine({ config: signalConfig() }).evaluate({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles: [...candles.slice(0, -1), unfinished],
    });
    assert.equal(evaluation.eligible, false);
    assert.equal(evaluation.reason, 'UNFINISHED_CANDLE');
    assert.deepEqual(evaluation.signals, []);
  });

  it('does not trust an explicit closed flag for a candle after the as-of time', () => {
    const now = Date.UTC(2026, 0, 1, 1);
    const past = makeCandle(now - HOUR, 100, { isClosed: true });
    const future = makeCandle(now + HOUR, 200, { isClosed: true });
    const closed = filterClosedCandles([past, future], {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      now,
    });

    assert.deepEqual(closed.map(candle => candle.open_time), [past.open_time]);
  });
});

describe('SignalEngine parity and lineage', () => {
  it('returns deterministic equivalent output for the same dataset and config', () => {
    const candles = makeDonchianDataset();
    const generatedAt = '2026-02-01T00:00:00.000Z';
    const engine = new SignalEngine({
      config: signalConfig(),
      versionOptions: { commitSha: 'test-sha', modelVersion: 'v1-test' },
    });
    const first = engine.evaluate({ symbol: 'BTCUSDT', candles, generatedAt });
    const second = engine.evaluate({
      symbol: 'BTCUSDT',
      candles: candles.map(candle => ({ ...candle })),
      generatedAt,
    });

    assert.deepEqual(first.signals, second.signals);
    assert.equal(first.signals[0].symbol, 'BTCUSDT');
    assert.equal(first.signals[0].direction, first.signals[0].signal);
    assert.equal(first.signals[0].candle_open_time, new Date(candles.at(-1).open_time).toISOString());
    assert.equal(first.signals[0].model_version, 'v1-test');
    assert.equal(first.signals[0].commit_sha, 'test-sha');
    assert.equal(first.signals[0].generated_at, generatedAt);
    assert.ok(first.signals[0].config_hash);
    assert.ok(first.signals[0].raw_features);
  });

  it('sorts the same candle dataset consistently across ingestion order', () => {
    const candles = makeDonchianDataset();
    const engine = new SignalEngine({ config: signalConfig() });
    const generatedAt = '2026-02-01T00:00:00.000Z';
    const ordered = engine.evaluate({ symbol: 'BTCUSDT', candles, generatedAt });
    const reversed = engine.evaluate({
      symbol: 'BTCUSDT',
      candles: [...candles].reverse(),
      generatedAt,
    });
    assert.deepEqual(reversed.signals, ordered.signals);
  });

  it('preserves the strategy score as raw_score without integer rounding', () => {
    const candles = Array.from({ length: 21 }, (_, index) => makeCandle(
      Date.UTC(2026, 0, 1) + index * HOUR,
      100,
    ));
    const config = {
      ...signalConfig(),
      DEFAULT_STRATEGIES: {
        rsi_reversal: { enabled: true, oversold: 35, overbought: 65, rsi_period: 14 },
      },
    };
    const indicators = createIndicatorSnapshot({
      currentPrice: 100,
      atr_14: 2,
      rsi_14: 20,
    }, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles,
      lookbackCandles: 21,
    });
    const result = new SignalEngine({ config }).evaluate({
      symbol: 'BTCUSDT',
      candles,
      now: candles.at(-1).close_time + 1,
      indicators,
    });

    assert.equal(result.signals[0].score, 69.3);
    assert.equal(result.signals[0].confidence, 69);
    assert.equal(result.signals[0].raw_score, 69.3);
  });

  it('matches live, serverless, and backtest projections', () => {
    const candles = makeDonchianDataset();
    const config = signalConfig();
    const now = candles.at(-1).close_time + 1;
    const live = new SignalEngine({ config }).evaluate({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles,
      now,
    });
    const serverless = evaluateSymbolCandles('BTCUSDT', candles, { config, now });
    const backtest = evaluateBacktestCandle({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles,
      config,
      now,
    });
    const project = evaluation => evaluation.signals.map(signal => ({
      symbol: signal.symbol,
      direction: signal.direction,
      strategy: signal.strategy,
      score: signal.raw_score,
      entry_reference: signal.entry_reference,
      filters: signal.filter_reasons,
      signal_timestamp: signal.signal_timestamp,
    }));

    assert.ok(project(live).length > 0);
    assert.deepEqual(project(serverless), project(live));
    assert.deepEqual(project(backtest), project(live));
  });
});

describe('Donchian previous-channel regression', () => {
  it('does not include the current candle high in its breakout channel', () => {
    const candles = Array.from({ length: 21 }, (_, index) => ({
      high: index === 20 ? 1000 : 100 + index,
      low: 90,
      close: index === 20 ? 1000 : 100 + index,
    }));
    const channel = donchianChannel(candles, 20);
    assert.equal(channel.upper, 119);
    assert.equal(channel.lower, 90);
  });
});

describe('Historical pagination and coverage', () => {
  it('ends a requested window at the latest fully closed candle', () => {
    const asOf = Date.UTC(2026, 0, 1, 1, 30);
    const window = requestedWindow(1, { asOf, timeframe: '1h' });
    assert.equal(window.endOpen, Date.UTC(2026, 0, 1, 0));
    assert.equal(window.requestedEnd, Date.UTC(2026, 0, 1, 1) - 1);
  });

  it('loads multiple pages and advances the cursor without truncation', async () => {
    const pages = [
      [0, 1],
      [2, 3],
      [4],
    ];
    let calls = 0;
    const rows = await getHistoricalCandles('BTCUSDT', '1h', {
      startTime: 0,
      endTime: 4 * HOUR,
      pageLimit: 2,
      fetchPage: async request => {
        assert.equal(request.symbol, 'BTCUSDT');
        calls++;
        return pages[calls - 1].map(index => [
          index * HOUR, '100', '101', '99', '100', '10',
          index * HOUR + HOUR - 1,
        ]);
      },
    });
    assert.equal(calls, 3);
    assert.equal(rows.length, 5);
    assert.deepEqual(rows.map(row => row[0]), [0, HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
  });

  it('reports exact requested coverage and hard-fails a missing candle', async () => {
    const asOf = Date.UTC(2026, 0, 3);
    const window = requestedWindow(2, { asOf, timeframe: '1h' });
    const candles = Array.from({ length: 148 }, (_, index) => makeCandle(
      window.startOpen - 100 * HOUR + index * HOUR,
      100 + index,
    ));
    const history = await loadBacktestHistory('BTCUSDT', 2, {
      candles,
      asOf,
      timeframe: '1h',
    });
    assert.equal(history.coverage.candles_expected, 48);
    assert.equal(history.coverage.candles_loaded, 48);
    assert.equal(history.coverage.missing_candles, 0);
    assert.equal(history.coverage.coverage_percent, 100);
    assert.equal(history.candles.length, 148);

    const missing = candles.filter(candle => candle.open_time !== window.startOpen);
    await assert.rejects(
      () => loadBacktestHistory('BTCUSDT', 2, { candles: missing, asOf, timeframe: '1h' }),
      error => error instanceof CoverageError && error.coverage.missing_candles === 1,
    );
  });

  it('hard-fails when the requested window is complete but warmup is incomplete', async () => {
    const asOf = Date.UTC(2026, 0, 3);
    const window = requestedWindow(2, { asOf, timeframe: '1h' });
    const candles = Array.from({ length: 48 }, (_, index) => makeCandle(
      window.startOpen + index * HOUR,
      100 + index,
    ));

    await assert.rejects(
      () => loadBacktestHistory('BTCUSDT', 2, {
        candles,
        asOf,
        timeframe: '1h',
        warmup: 20,
      }),
      error => error instanceof CoverageError
        && error.coverage.coverage_percent === 100
        && error.coverage.warmup_missing_candles === 20,
    );
  });

  it('hard-fails incomplete 90d, 180d and 365d requested windows', () => {
    const asOf = Date.UTC(2026, 0, 1);
    for (const days of [90, 180, 365]) {
      const report = buildCoverageReport([], days, { asOf, timeframe: '1h' });
      assert.equal(report.candles_expected, days * 24);
      assert.equal(report.candles_loaded, 0);
      assert.throws(() => assertCoverage(report), CoverageError);
    }

    assert.throws(
      () => assertCoverage({
        coverage_percent: 99.99,
        candles_loaded: 8760 - 1,
        candles_expected: 8760,
        missing_candles: 1,
      }),
      CoverageError,
    );
  });

  it('fails the aggregate experiment when any symbol has incomplete coverage', async () => {
    const asOf = Date.UTC(2026, 0, 2, 1);
    const window = requestedWindow(1, { asOf, timeframe: '1h' });
    const candles = Array.from({ length: window.expected - 1 }, (_, index) => {
      return makeCandle(window.startOpen + index * HOUR, 100 + index);
    });
    const config = {
      ...signalConfig(),
      MONITOR_TIERS: {
        tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
      },
      BINANCE_SYMBOLS: ['BTCUSDT'],
    };

    await assert.rejects(
      () => backtestAll(1, {
        config,
        candlesBySymbol: { BTCUSDT: candles },
        asOf,
      }),
      error => {
        assert.match(error.message, /failed closed/i);
        assert.equal(error.errors[0].symbol, 'BTCUSDT');
        assert.equal(error.errors[0].coverage.missing_candles, 1);
        return true;
      },
    );
  });
});

describe('Future leakage regression', () => {
  it('never exposes later candles to the indicator computation at an earlier timestamp', async () => {
    const config = {
      ...signalConfig(),
      MONITOR_TIERS: {
        tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
      },
      BINANCE_SYMBOLS: ['BTCUSDT'],
    };
    const asOf = Date.UTC(2026, 0, 5);
    const warmup = 60;
    const window = requestedWindow(1, { asOf, timeframe: '1h' });
    const sentinelOpenTime = window.endOpen;
    const candles = Array.from({ length: warmup + 24 }, (_, index) => {
      const openTime = window.startOpen - warmup * HOUR + index * HOUR;
      return makeCandle(openTime, openTime === sentinelOpenTime ? 100000 : 100 + index);
    });
    const observedLastTimes = [];

    await backtestSymbol('BTCUSDT', 1, {
      config,
      candles,
      asOf,
      warmup,
      minConfidence: 0,
      noConflictFilter: false,
      boostResonance: false,
      computeIndicatorsFn: slice => {
        const lastOpenTime = slice.at(-1).open_time;
        observedLastTimes.push(lastOpenTime);
        if (lastOpenTime < sentinelOpenTime) {
          assert.equal(slice.some(candle => candle.close === 100000), false);
        }
        return computeAllIndicators(slice);
      },
    });

    assert.equal(observedLastTimes.length, 24);
    assert.equal(observedLastTimes[0], window.startOpen);
    assert.equal(observedLastTimes.at(-1), sentinelOpenTime);
  });
});

describe('Backtest shared-engine parity', () => {
  it('uses candlesBySymbol and indicatorsBySymbol through the same SignalEngine path', async () => {
    const config = {
      ...signalConfig(),
      MONITOR_TIERS: {
        tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
      },
      BINANCE_SYMBOLS: ['BTCUSDT'],
    };
    const asOf = Date.UTC(2026, 0, 3);
    const window = requestedWindow(2, { asOf, timeframe: '1h' });
    const candles = Array.from({ length: 69 }, (_, index) => {
      const breakout = index === 68;
      return makeCandle(window.startOpen - 21 * HOUR + index * HOUR, breakout ? 200 : 100 + index * 0.1, {
        highExtra: breakout ? 0 : 1,
      });
    });
    let indicatorCalls = 0;
    const result = await backtestSymbol('BTCUSDT', 2, {
      config,
      candlesBySymbol: { BTCUSDT: candles },
      indicatorsBySymbol: {
        BTCUSDT: ({ candles: slice }) => {
          indicatorCalls++;
          return computeAllIndicators(slice);
        },
      },
      asOf,
      warmup: 21,
      minConfidence: 0,
      noConflictFilter: false,
      boostResonance: false,
      strictCoverage: true,
    });

    assert.equal(result.coverage.coverage_percent, 100);
    assert.equal(result.totalTrades, 1);
    assert.equal(result.signalEvaluations.length, 1);
    assert.ok(indicatorCalls > 0);
  });

  it('evaluates every eligible signal, including signals not opened as trades', async () => {
    const config = {
      ...signalConfig(),
      MONITOR_TIERS: {
        tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
      },
      BINANCE_SYMBOLS: ['BTCUSDT'],
    };
    const start = Date.UTC(2026, 0, 1);
    const candles = Array.from({ length: 35 }, (_, index) => makeCandle(
      start + index * HOUR,
      100 + index * 2,
      { highExtra: 0.5, lowExtra: 0.5 },
    ));
    const result = await backtestSymbol('BTCUSDT', 1, {
      config,
      candles,
      indicatorSeries: ({ candles: slice }) => computeAllIndicators(slice),
      warmup: 21,
      minConfidence: 0,
      noConflictFilter: false,
      boostResonance: false,
      cooldownMinutes: 240,
    });

    assert.equal(result.signalEvaluations.length, result.filteredSignalCount);
    assert.ok(result.signalEvaluations.length > result.totalTrades);
  });

  it('applies stop-loss and take-profit ATR parameters to account simulation', async () => {
    const config = {
      ...signalConfig(),
      MONITOR_TIERS: {
        tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
      },
      BINANCE_SYMBOLS: ['BTCUSDT'],
    };
    const candles = makeDonchianDataset(60);
    const common = {
      config,
      candles,
      indicatorSeries: ({ candles: slice }) => computeAllIndicators(slice),
      warmup: 21,
      minConfidence: 0,
      noConflictFilter: false,
      boostResonance: false,
    };
    const narrow = await backtestSymbol('BTCUSDT', 1, {
      ...common,
      stopLossATR: 1,
      takeProfitATR: 2,
    });
    const wide = await backtestSymbol('BTCUSDT', 1, {
      ...common,
      stopLossATR: 2,
      takeProfitATR: 4,
    });

    assert.notEqual(narrow.trades[0].stopLoss, wide.trades[0].stopLoss);
    assert.notEqual(narrow.trades[0].target, wide.trades[0].target);
  });
});

describe('SignalEvaluator', () => {
  it('normalizes SELL returns and records forward/MFE/MAE outcomes', () => {
    const candles = Array.from({ length: 50 }, (_, index) => makeCandle(
      index * HOUR,
      index === 0 ? 100 : 100 - index,
      { highExtra: 1, lowExtra: 1 },
    ));
    const signal = {
      symbol: 'BTCUSDT',
      strategy: 'test',
      signal: 'SELL',
      direction: 'SELL',
      suggestedEntry: 100,
      targetPrice: 95,
      stopLoss: 105,
      signal_timestamp: new Date(0).toISOString(),
    };
    const result = new SignalEvaluator({ roundTripCostPercent: 0.14 }).evaluate(
      signal,
      candles,
      { signalIndex: 0 },
    );
    assert.equal(directionReturnPercent('SELL', 100, 98), 2);
    assert.equal(result.forward_returns['1h'], 1);
    assert.ok(result.mfe_percent > 0);
    assert.ok(result.mae_percent <= 0);
    assert.equal(result.tp_first, true);
    assert.equal(result.net_forward_returns['1h'], 0.86);
  });

  it('caps excursion metrics at the longest configured horizon', () => {
    const candles = Array.from({ length: 51 }, (_, index) => makeCandle(
      index * HOUR,
      index === 49 ? 1 : 100,
      { highExtra: 0, lowExtra: 0 },
    ));
    const result = new SignalEvaluator().evaluate({
      symbol: 'BTCUSDT',
      strategy: 'test',
      signal: 'SELL',
      suggestedEntry: 100,
      signal_timestamp: new Date(0).toISOString(),
    }, candles, { signalIndex: 0 });

    assert.equal(result.mfe_percent, 0);
    assert.equal(result.forward_returns['48h'], 0);
  });

  it('does not treat null TP/SL values or an unknown direction as valid outcomes', () => {
    const start = Date.UTC(2026, 0, 1);
    const candles = [
      makeCandle(start, 100),
      makeCandle(start + HOUR, 101),
    ];
    const evaluator = new SignalEvaluator({ horizons: [1] });
    const result = evaluator.evaluate({
      symbol: 'BTCUSDT',
      strategy: 'test',
      direction: 'BUY',
      signal_timestamp: new Date(candles[0].close_time).toISOString(),
      suggestedEntry: 100,
      targetPrice: null,
      stopLoss: null,
    }, candles, { signalIndex: 0 });

    assert.equal(result.tp_first, false);
    assert.equal(result.sl_first, false);
    assert.equal(result.tp_sl_outcome, 'neither');
    assert.equal(directionReturnPercent('HOLD', 100, 101), null);
  });
});

describe('Optimizer parameter-effect checks', () => {
  it('proves an optimization parameter changes the real backtest output', async () => {
    const config = {
      ...signalConfig(),
      MONITOR_TIERS: {
        tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
      },
      BINANCE_SYMBOLS: ['BTCUSDT'],
    };
    const candles = makeDonchianDataset(60);
    const analysis = await runOptimizationGrid({
      days: 1,
      candidates: { stopLossATR: [1, 2] },
      baseOptions: {
        config,
        candles,
        indicatorSeries: ({ candles: slice }) => computeAllIndicators(slice),
        warmup: 21,
        minConfidence: 0,
        noConflictFilter: false,
        boostResonance: false,
        takeProfitATR: 3,
      },
      backtestFn: async (days, options) => {
        const result = await backtestSymbol('BTCUSDT', days, options);
        return {
          totalSymbols: 1,
          totalTrades: result.totalTrades,
          results: [result],
          errors: [],
        };
      },
      returnAnalysis: true,
    });

    assert.equal(analysis.parameterEffect.passed, true);
    assert.equal(analysis.parameterEffect.effects[0].outputChanged, true);
    assert.equal(analysis.noOp.passed, true);
  });
});

describe('Signal storage and delivery state', () => {
  const config = {
    SUPABASE: { ENABLED: false },
    MONITOR_TIERS: { tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240 } },
  };

  it('does not mark a signal delivered before the email succeeds', async () => {
    const store = new SignalStore({ config });
    const signal = {
      symbol: 'BTCUSDT',
      strategy: 'test',
      signal: 'SELL',
      confidence: 80,
      suggestedEntry: 100,
      stopLoss: 105,
      targetPrice: 95,
      signal_timestamp: new Date(0).toISOString(),
      candle_open_time: new Date(0).toISOString(),
      candle_close_time: new Date(HOUR - 1).toISOString(),
      timeframe: '1h',
      raw_features: {},
    };
    const calls = [];
    const result = await persistAndNotify({
      signal,
      signalStore: store,
      sendEmail: async emailSignal => {
        const cached = store.memoryStore.get('BTCUSDT:test:SELL');
        calls.push({
          persistedStatus: cached.row.signal_status,
          direction: emailSignal.signal,
          suggestedEntry: emailSignal.suggestedEntry,
        });
        return true;
      },
    });
    assert.deepEqual(calls, [{
      persistedStatus: 'delivery_pending',
      direction: 'SELL',
      suggestedEntry: 100,
    }]);
    assert.equal(result.record.signal_status, 'delivered');
    assert.equal(result.record.delivery_status, 'delivered');
    assert.equal(result.record.email_delivery_status, 'sent');
    assert.ok(result.record.delivered_at);
    assert.equal(await store.isDuplicate(signal), true);
  });

  it('keeps failed delivery observable and retryable', async () => {
    const store = new SignalStore({ config });
    const signal = { symbol: 'BTCUSDT', strategy: 'test-failed', signal: 'BUY', confidence: 80 };
    const persisted = await store.save(signal);
    const pending = await store.markDeliveryPending(persisted);
    const failed = await store.markDeliveryFailed(pending, new Error('SMTP down'));
    assert.equal(failed.signal_status, 'delivery_failed');
    assert.equal(failed.delivery_status, 'delivery_failed');
    assert.equal(failed.email_delivery_status, 'failed');
    assert.match(failed.delivery_error, /SMTP down/);
    assert.equal(await store.isDuplicate(signal), false);
  });

  it('does not mark delivery retryable after email succeeds but confirmation fails', async () => {
    const calls = [];
    const signal = { symbol: 'BTCUSDT', strategy: 'confirmation-failure', signal: 'SELL' };
    const record = { ...signal, dedupe_key: 'key', signal_status: 'persisted' };
    const store = {
      save: async () => { calls.push('save'); return record; },
      markDeliveryPending: async value => {
        calls.push('pending');
        return { ...value, signal_status: 'delivery_pending' };
      },
      markDelivered: async () => {
        calls.push('delivered');
        throw new Error('database update failed');
      },
      markDeliveryFailed: async () => {
        calls.push('failed');
      },
    };

    await assert.rejects(
      () => persistAndNotify({ signal, signalStore: store, sendEmail: async () => true }),
      /email was sent but delivery confirmation failed/i,
    );
    assert.deepEqual(calls, ['save', 'pending', 'delivered']);
  });

  it('fails closed when Supabase is configured but unavailable', async () => {
    const store = new SignalStore({
      config: { SUPABASE: { ENABLED: true }, MONITOR_TIERS: {} },
      supabaseClient: null,
    });
    await assert.rejects(
      () => store.save({ symbol: 'BTCUSDT', strategy: 'test', signal: 'BUY' }),
      /Supabase.*unavailable/i,
    );
  });

  it('surfaces Supabase insert errors before any delivery attempt', async () => {
    const insertError = new Error('insert denied');
    const supabaseClient = {
      from: () => ({
        insert: () => ({
          select: () => ({
            single: async () => ({ data: null, error: insertError }),
          }),
        }),
      }),
    };
    const store = new SignalStore({
      config: { SUPABASE: { ENABLED: true }, MONITOR_TIERS: {} },
      supabaseClient,
    });

    await assert.rejects(
      () => store.save({ symbol: 'BTCUSDT', strategy: 'insert-error', signal: 'BUY' }),
      /insert denied/,
    );
  });

  it('surfaces a Supabase update that matched no persisted row', async () => {
    const supabaseClient = {
      from: () => ({
        insert: row => ({
          select: () => ({
            single: async () => ({ data: { ...row, id: 1 }, error: null }),
          }),
        }),
        update: () => {
          const builder = {
            eq: () => builder,
            select: async () => ({ data: [], error: null }),
          };
          return builder;
        },
      }),
    };
    const store = new SignalStore({
      config: { SUPABASE: { ENABLED: true }, MONITOR_TIERS: {} },
      supabaseClient,
    });
    const persisted = await store.save({
      symbol: 'BTCUSDT',
      strategy: 'update-zero-row',
      signal: 'SELL',
    });

    await assert.rejects(
      () => store.markDeliveryPending(persisted),
      /matched no signal row/,
    );
  });
});

describe('Serverless authorization and migration compatibility', () => {
  it('requires an exact Bearer CRON_SECRET when configured', () => {
    assert.equal(authorizeCronRequest({ headers: { authorization: 'Bearer secret' } }, 'secret').authorized, true);
    assert.equal(authorizeCronRequest({ headers: { authorization: 'Bearer wrong' } }, 'secret').authorized, false);
    assert.equal(authorizeCronRequest({ headers: {} }, 'secret').authorized, false);
    assert.equal(authorizeCronRequest({ headers: {} }, '', { requireConfigured: false }).authorized, true);
    const missingProductionSecret = authorizeCronRequest(
      { headers: {} },
      '',
      { requireConfigured: true },
    );
    assert.equal(missingProductionSecret.authorized, false);
    assert.equal(missingProductionSecret.configured, false);
  });

  it('keeps the signal migration additive and preserves existing rows', () => {
    const migration = readFileSync(new URL('../supabase/migrations/20260828_signal_integrity.sql', import.meta.url), 'utf8');
    const reviewSchemaMigration = readFileSync(new URL('../supabase/migrations/20260901_sync_signal_review_schema.sql', import.meta.url), 'utf8');
    const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
    assert.doesNotMatch(migration, /^\s*(DROP|DELETE|UPDATE)\s+/im);
    assert.doesNotMatch(reviewSchemaMigration, /^\s*(DROP|DELETE|UPDATE)\s+/im);
    for (const field of ['model_version', 'commit_sha', 'config_hash', 'raw_features', 'delivery_status']) {
      assert.match(migration, new RegExp('ADD COLUMN IF NOT EXISTS ' + field));
    }
    assert.match(migration, /GRANT SELECT ON TABLE public\.crypto_signals TO anon/i);
    assert.match(migration, /GRANT SELECT, INSERT, UPDATE ON TABLE public\.crypto_signals TO service_role/i);
    assert.match(schema, /REVOKE ALL PRIVILEGES ON TABLE public\.crypto_signals FROM anon, authenticated, service_role/i);
    for (const field of ['email_delivery_status', 'review_status', 'review_checked_until', 'review_ambiguous_candle']) {
      assert.match(reviewSchemaMigration, new RegExp('ADD COLUMN IF NOT EXISTS ' + field));
      assert.match(schema, new RegExp(field));
    }
    assert.doesNotMatch(schema, /DELETE FROM crypto_signals/i);
    assert.doesNotMatch(schema, /clean_old_signals/i);
  });

  it('defines Hobby-compatible Vercel schedules and a supported Node runtime', () => {
    const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
    assert.deepEqual(vercel.crons.map(cron => cron.schedule), [
      '0 0 * * *',
      '0 1 * * *',
      '0 2 * * *',
    ]);
    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    assert.match(workflow, /node-version:\s*(?:['"]?)(?:20|22)(?:['"]?)/);
  });
});

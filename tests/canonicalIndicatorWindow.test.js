import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { computeAllIndicators } from '../src/indicators/index.js';
import { createIndicatorSnapshot, getIndicatorProvenance } from '../src/indicators/provenance.js';
import { precomputeIndicatorSeries } from '../src/backtest/indicatorSeries.js';
import { backtestSymbol, evaluateBacktestCandle } from '../src/backtest/engine.js';
import { requestedWindow } from '../src/backtest/history.js';
import { runOptimizationGrid } from '../src/backtest/optimizer.js';
import { SignalEngine } from '../src/signal/engine.js';
import { checkSymbol, evaluateSymbolCandles } from '../api/lib/checker.js';

const HOUR = 60 * 60 * 1000;
const N = getIndicatorLookback(CONFIG);
const START = Date.UTC(2026, 0, 1);

function makeCandle(index, close, options = {}) {
  const openTime = START + index * HOUR;
  return {
    open: close,
    high: close + (options.highExtra ?? 1),
    low: close - (options.lowExtra ?? 1),
    close,
    volume: options.volume ?? 1000 + (index % 17) * 10,
    open_time: openTime,
    close_time: openTime + HOUR - 1,
    timeframe: '1h',
    is_closed: options.isClosed ?? true,
    symbol: 'BTCUSDT',
  };
}

function makeDataset(count = 360, spikes = new Set()) {
  return Array.from({ length: count }, (_, index) => {
    const base = 100 + index * 0.08 + Math.sin(index / 7) * 2;
    const close = spikes.has(index) ? 220 : base;
    return makeCandle(index, close, {
      highExtra: spikes.has(index) ? 0 : 1,
      lowExtra: 1,
    });
  });
}

function parityConfig(lookbackCandles = N) {
  return {
    INDICATOR_LOOKBACK_CANDLES: lookbackCandles,
    DEFAULT_STRATEGIES: {
      donchian_breakout: {
        enabled: true,
        period: 20,
        channel_position_threshold: 0.9,
        timeframe: '1h',
      },
    },
    SIGNAL_FILTER: {
      minConfidence: 0,
      filterConflicts: false,
      boostResonance: false,
      buyRequiresTrendConfirm: false,
    },
    PROFIT_FILTER: { enabled: false },
    TRADING_COSTS: { roundTripPercent: 0 },
    MONITOR_TIERS: {
      tier1: { symbols: ['BTCUSDT'], cooldownMinutes: 240, intervalMinutes: 60 },
    },
    BINANCE_SYMBOLS: ['BTCUSDT'],
  };
}

function signalProjection(evaluation) {
  return {
    indicators: evaluation.indicators,
    rawSignals: evaluation.rawSignals,
    qualitySignals: evaluation.qualitySignals,
    signals: evaluation.signals,
  };
}

function experimentCandles(dataset, asOf, days = 1) {
  const window = requestedWindow(days, { asOf, timeframe: '1h' });
  const firstIndex = dataset.findIndex(candle => candle.open_time === window.startOpen - N * HOUR);
  assert.ok(firstIndex >= 0, 'fixture must include canonical warmup history');
  return dataset.slice(firstIndex, firstIndex + N + window.expected);
}

describe('Canonical indicator window parity', () => {
  it('keeps long-history direct, live, serverless, backtest and optimizer paths identical', async () => {
    const config = parityConfig();
    const dataset = makeDataset(360, new Set([319]));
    const targetIndex = 319;
    const target = dataset[targetIndex];
    const now = target.close_time + 1;
    const generatedAt = new Date(now).toISOString();
    const prefix = dataset.slice(0, targetIndex + 1);
    const engine = new SignalEngine({ config });

    const direct = engine.evaluate({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles: prefix,
      now,
      generatedAt,
    });
    const live = engine.evaluate({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles: prefix.slice(-N),
      now,
      generatedAt,
    });
    const serverless = evaluateSymbolCandles('BTCUSDT', [
      ...prefix,
      makeCandle(targetIndex + 1, 221, { isClosed: false }),
    ], { config, now, generatedAt });
    const backtest = evaluateBacktestCandle({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles: prefix,
      config,
      now,
      generatedAt,
    });

    const series = precomputeIndicatorSeries(prefix, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      config,
      indicatorLookbackCandles: N,
    });
    const precomputed = evaluateBacktestCandle({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles: prefix,
      config,
      indicators: series[targetIndex],
      now,
      generatedAt,
    });

    assert.equal(direct.eligible, true);
    assert.equal(direct.indicatorCandles.length, N);
    assert.deepEqual(signalProjection(live), signalProjection(direct));
    assert.deepEqual(signalProjection(serverless), signalProjection(direct));
    assert.deepEqual(signalProjection(backtest), signalProjection(direct));
    assert.deepEqual(signalProjection(precomputed), signalProjection(direct));

    const asOf = now;
    const candles = experimentCandles(dataset, asOf);
    const experimentSeries = precomputeIndicatorSeries(candles, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      config,
      indicatorLookbackCandles: N,
    });
    const onDemandResult = await backtestSymbol('BTCUSDT', 1, {
      config,
      candles,
      asOf,
      indicatorLookbackCandles: N,
      strictCoverage: true,
      minConfidence: 0,
      noConflictFilter: false,
      boostResonance: false,
    });
    const optimizer = await runOptimizationGrid({
      days: 1,
      candidates: { minConfidence: [0] },
      baseOptions: {
        config,
        candles,
        asOf,
        indicatorLookbackCandles: N,
        indicatorsBySymbol: { BTCUSDT: experimentSeries },
        strictCoverage: true,
        noConflictFilter: false,
        boostResonance: false,
      },
      includeBacktest: true,
    });
    const optimizerResult = optimizer[0].backtest.results[0];
    assert.deepEqual(optimizerResult.signalEvaluations, onDemandResult.signalEvaluations);
    assert.equal(optimizerResult.totalTrades, onDemandResult.totalTrades);
    assert.equal(optimizerResult.filteredSignalCount, onDemandResult.filteredSignalCount);
  });

  it('changes signal config hash when the canonical window changes', () => {
    const dataset = makeDataset(220, new Set([219]));
    const now = dataset.at(-1).close_time + 1;
    const first = new SignalEngine({ config: parityConfig(100) }).evaluate({
      symbol: 'BTCUSDT', candles: dataset, now, generatedAt: new Date(now).toISOString(),
    });
    const second = new SignalEngine({ config: parityConfig(101) }).evaluate({
      symbol: 'BTCUSDT', candles: dataset, now, generatedAt: new Date(now).toISOString(),
    });

    assert.notEqual(first.configHash, second.configHash);
    assert.equal(first.indicatorLookbackCandles, 100);
    assert.equal(second.indicatorLookbackCandles, 101);
  });

  it('does not allow an unverified indicator object to bypass the canonical window', () => {
    const config = parityConfig();
    const dataset = makeDataset(N, new Set([N - 1]));
    const now = dataset.at(-1).close_time + 1;
    const result = new SignalEngine({ config }).evaluate({
      symbol: 'BTCUSDT',
      candles: dataset,
      now,
      indicators: {
        currentPrice: 999999,
        rsi_14: 0,
        atr_14: 1,
      },
    });

    assert.equal(result.indicators.currentPrice, dataset.at(-1).close);
    assert.notEqual(result.indicators.currentPrice, 999999);
  });
});

describe('Old-history poison regression', () => {
  it('produces identical indicators and signals when only pre-window history changes', () => {
    const config = parityConfig();
    const datasetA = makeDataset(360, new Set([319]));
    const datasetB = datasetA.map((candle, index) => index < 200
      ? { ...candle, open: 10000, high: 10001, low: 9999, close: 10000 }
      : { ...candle });
    const target = datasetA.at(-1);
    const now = target.close_time + 1;
    const generatedAt = new Date(now).toISOString();
    const first = new SignalEngine({ config }).evaluate({
      symbol: 'BTCUSDT', candles: datasetA, now, generatedAt,
    });
    const second = new SignalEngine({ config }).evaluate({
      symbol: 'BTCUSDT', candles: datasetB, now, generatedAt,
    });

    assert.deepEqual(second.indicators, first.indicators);
    assert.deepEqual(signalProjection(second), signalProjection(first));
  });
});

describe('Serverless candle margin regressions', () => {
  it('requests N plus a margin from REST before filtering the forming candle', async () => {
    const config = { ...parityConfig(), DEFAULT_STRATEGIES: {} };
    const closed = makeDataset(N);
    let requestedLimit;
    await checkSymbol('BTCUSDT', {
      config,
      now: closed.at(-1).close_time + 1,
      candleFetcher: async (symbol, timeframe, limit) => {
        requestedLimit = limit;
        return [...closed, makeCandle(N, 221, { isClosed: false })];
      },
    });

    assert.equal(requestedLimit, N + 2);
  });

  it('uses exactly N closed candles from N closed plus one forming candle', () => {
    const config = parityConfig();
    const closed = makeDataset(N, new Set([N - 1]));
    const target = closed.at(-1);
    const now = target.close_time + 1;
    const generatedAt = new Date(now).toISOString();
    const forming = makeCandle(N, 221, { isClosed: false });
    const serverless = evaluateSymbolCandles('BTCUSDT', [...closed, forming], {
      config,
      now,
      generatedAt,
    });
    const direct = new SignalEngine({ config }).evaluate({
      symbol: 'BTCUSDT',
      timeframe: '1h',
      candles: closed,
      now,
      generatedAt,
    });

    assert.equal(serverless.eligible, true);
    assert.equal(serverless.indicatorCandles.length, N);
    assert.deepEqual(signalProjection(serverless), signalProjection(direct));
  });

  it('fails closed with N-1 closed candles', () => {
    const config = parityConfig();
    const closed = makeDataset(N - 1);
    const result = evaluateSymbolCandles('BTCUSDT', closed, {
      config,
      now: closed.at(-1).close_time + 1,
    });

    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'INSUFFICIENT_CANDLE_WINDOW');
    assert.equal(result.indicatorLookbackCandles, N);
    assert.deepEqual(result.signals, []);
  });
});

describe('Precomputed versus on-demand indicator regression', () => {
  it('matches every indicator and signal projection over a 250+ candle history', () => {
    const config = parityConfig();
    const dataset = makeDataset(360, new Set([179, 249, 359]));
    const series = precomputeIndicatorSeries(dataset, {
      symbol: 'BTCUSDT',
      timeframe: '1h',
      config,
      indicatorLookbackCandles: N,
    });

    for (const index of [N - 1, N, 150, 249, 359]) {
      const window = dataset.slice(index - N + 1, index + 1);
      const expectedIndicators = computeAllIndicators(window);
      assert.deepEqual(series[index], expectedIndicators);

      const now = dataset[index].close_time + 1;
      const generatedAt = new Date(now).toISOString();
      const onDemand = evaluateBacktestCandle({
        symbol: 'BTCUSDT', candles: dataset.slice(0, index + 1), config, now, generatedAt,
      });
      const precomputed = evaluateBacktestCandle({
        symbol: 'BTCUSDT',
        candles: dataset.slice(0, index + 1),
        config,
        indicators: series[index],
        now,
        generatedAt,
      });
      assert.deepEqual(precomputed.indicators, onDemand.indicators);
      assert.deepEqual(signalProjection(precomputed), signalProjection(onDemand));
    }

    const provenance = getIndicatorProvenance(series.at(-1));
    assert.equal(provenance.lookback_candles, N);
    assert.equal(provenance.candle_count, N);
    assert.equal(provenance.candle_close_time, dataset.at(-1).close_time);
  });
});

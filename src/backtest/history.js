// Historical candle loading and hard coverage validation for experiments.

import { getHistoricalCandles } from '../websocket/rest.js';
import {
  candleToIso,
  filterClosedCandles,
  intervalToMs,
  normalizeCandle,
} from '../market/candle.js';

export class CoverageError extends Error {
  constructor(report) {
    const warmup = report.warmup_missing_candles > 0
      ? ', warmup ' + report.warmup_loaded + '/' + report.warmup_expected
      : '';
    super('Historical coverage failed: ' + report.coverage_percent + '% (' + report.candles_loaded + '/' + report.candles_expected + ' candles' + warmup + ')');
    this.name = 'CoverageError';
    this.coverage = report;
  }
}

function floorToInterval(timestamp, step) {
  return Math.floor(timestamp / step) * step;
}

export function requestedWindow(days, { asOf = Date.now(), timeframe = '1h' } = {}) {
  const step = intervalToMs(timeframe);
  const expected = Math.max(1, Math.round(days * 24 * 60 * 60 * 1000 / step));
  // Binance close_time is the next interval boundary minus 1 ms. Adding one
  // millisecond handles an exact close timestamp while excluding the candle
  // currently forming at an arbitrary as-of time.
  const lastOpen = floorToInterval(asOf + 1, step) - step;
  const firstOpen = lastOpen - (expected - 1) * step;
  return {
    step,
    expected,
    startOpen: firstOpen,
    endOpen: lastOpen,
    requestedStart: firstOpen,
    requestedEnd: lastOpen + step - 1,
  };
}

export function buildCoverageReport(candles, days, options = {}) {
  const timeframe = options.timeframe || '1h';
  const window = requestedWindow(days, options);
  const normalized = filterClosedCandles(candles, {
    symbol: options.symbol,
    timeframe,
    now: options.asOf,
  });
  const inWindow = normalized.filter(candle => {
    return candle.open_time !== null
      && candle.open_time >= window.startOpen
      && candle.open_time <= window.endOpen;
  });
  const openTimes = [...new Set(inWindow.map(candle => candle.open_time))].sort((a, b) => a - b);
  const availableTimes = new Set(openTimes);
  const expectedTimes = Array.from(
    { length: window.expected },
    (_, index) => window.startOpen + index * window.step,
  );
  const candlesLoaded = expectedTimes.filter(openTime => availableTimes.has(openTime)).length;
  const candlesExpected = window.expected;

  return {
    requested_start: candleToIso(window.requestedStart),
    actual_start: openTimes.length ? candleToIso(openTimes[0]) : null,
    actual_end: openTimes.length
      ? candleToIso(openTimes.at(-1) + window.step - 1)
      : null,
    candles_expected: candlesExpected,
    candles_loaded: candlesLoaded,
    missing_candles: Math.max(0, candlesExpected - candlesLoaded),
    coverage_percent: +(candlesLoaded / candlesExpected * 100).toFixed(2),
    coverage_ratio: candlesLoaded / candlesExpected,
    requested_end: candleToIso(window.requestedEnd),
  };
}

export function assertCoverage(report, { minCoveragePercent = 100 } = {}) {
  const missing = report?.missing_candles
    ?? Math.max(0, (report?.candles_expected || 0) - (report?.candles_loaded || 0));
  const incomplete = report
    && (missing > 0 || (report.candles_loaded ?? 0) < (report.candles_expected ?? 0));
  if (!report || report.coverage_percent < minCoveragePercent || (minCoveragePercent >= 100 && incomplete)) {
    throw new CoverageError(report || {
      coverage_percent: 0,
      candles_loaded: 0,
      candles_expected: 0,
      missing_candles: 0,
    });
  }
  return report;
}

/**
 * Load warmup + requested candles. The data and fetch function are injectable
 * so coverage and pagination tests never need network access.
 */
export async function loadBacktestHistory(symbol, days, options = {}) {
  const timeframe = options.timeframe || '1h';
  const asOf = options.asOf ?? Date.now();
  const warmup = options.warmup ?? 100;
  const window = requestedWindow(days, { asOf, timeframe });
  const fetchPage = options.fetchPage;

  let rawCandles;
  if (options.candles) {
    rawCandles = options.candles;
  } else {
    rawCandles = await getHistoricalCandles(symbol, timeframe, {
      startTime: window.startOpen - warmup * window.step,
      endTime: window.requestedEnd,
      pageLimit: options.pageLimit,
      maxPages: options.maxPages,
      fetchPage,
    });
  }

  const normalized = filterClosedCandles((rawCandles || []).map(candle => normalizeCandle(candle, {
    symbol,
    timeframe,
    now: asOf,
  })), { symbol, timeframe, now: asOf });
  const coverage = buildCoverageReport(normalized, days, { symbol, timeframe, asOf });
  const warmupCandles = normalized.filter(candle => candle.open_time !== null && candle.open_time < window.startOpen).slice(-warmup);
  const requestedCandles = normalized.filter(candle => candle.open_time !== null && candle.open_time >= window.startOpen && candle.open_time <= window.endOpen);
  coverage.warmup_expected = warmup;
  coverage.warmup_loaded = warmupCandles.length;
  coverage.warmup_missing_candles = Math.max(0, warmup - warmupCandles.length);
  if (options.strictCoverage !== false) {
    assertCoverage(coverage, options);
    if (coverage.warmup_missing_candles > 0) throw new CoverageError(coverage);
  }

  return {
    candles: [...warmupCandles, ...requestedCandles],
    coverage,
    window,
  };
}

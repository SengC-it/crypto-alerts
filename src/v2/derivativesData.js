// Readers for Binance Vision's public USD-M derivatives archives.
// This module performs read-only downloads and never uses exchange credentials.

import { readArchiveEntry } from '../backtest/binanceArchive.js';

export const BINANCE_DERIVATIVES_ARCHIVE_BASE =
  'https://data.binance.vision/data/futures/um';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

function finite(value) {
  return value === null || value === undefined || value === ''
    ? null
    : Number.isFinite(Number(value)) ? Number(value) : null;
}

function timestampValue(value) {
  const numeric = finite(value);
  if (numeric !== null) return numeric;
  const text = String(value || '');
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(text)
    ? `${text.replace(' ', 'T')}Z`
    : text;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function datePart(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function monthPart(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 7);
}

function monthList(startTime, endTime) {
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  const months = [];
  let cursor = Date.UTC(new Date(start).getUTCFullYear(), new Date(start).getUTCMonth(), 1);
  const last = Date.UTC(new Date(end).getUTCFullYear(), new Date(end).getUTCMonth(), 1);
  while (cursor <= last) {
    months.push(monthPart(cursor));
    const date = new Date(cursor);
    cursor = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  }
  return months;
}

function dateList(startTime, endTime) {
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  const dates = [];
  for (let cursor = Math.floor(start / DAY) * DAY; cursor <= end; cursor += DAY) {
    dates.push(datePart(cursor));
  }
  return dates;
}

function parseCsvRows(csv) {
  const lines = String(csv || '').split(/\r?\n/).filter(line => line.trim());
  if (!lines.length) return [];
  const header = lines[0].replace(/^\uFEFF/, '').split(',').map(value => value.trim());
  return lines.slice(1).map(line => {
    const fields = line.split(',');
    return Object.fromEntries(header.map((key, index) => [key, fields[index] ?? '']));
  });
}

function parseFundingRows(csv, symbol) {
  return parseCsvRows(csv).flatMap(row => {
    const timestamp = timestampValue(row.calc_time ?? row.fundingTime);
    const rate = finite(row.last_funding_rate ?? row.fundingRate);
    if (timestamp === null || rate === null) return [];
    return [{
      symbol,
      source_timestamp: timestamp,
      availability_timestamp: timestamp,
      calc_time: timestamp,
      funding_interval_hours: finite(row.funding_interval_hours ?? row.fundingIntervalHours),
      funding_rate: rate,
      last_funding_rate: rate,
    }];
  });
}

function parsePremiumRows(csv, symbol) {
  return parseCsvRows(csv).flatMap(row => {
    const openTime = timestampValue(row.open_time ?? row.openTime);
    const closeTime = timestampValue(row.close_time ?? row.closeTime);
    const premium = finite(row.close ?? row.premium);
    if (openTime === null || premium === null) return [];
    const timestamp = closeTime ?? openTime;
    return [{
      symbol,
      source_timestamp: timestamp,
      availability_timestamp: timestamp,
      open_time: openTime,
      close_time: closeTime ?? timestamp,
      premium,
      close: premium,
    }];
  });
}

function parseMetricsRows(csv, symbol) {
  return parseCsvRows(csv).flatMap(row => {
    const timestamp = timestampValue(row.create_time ?? row.createTime);
    const openInterest = finite(row.sum_open_interest ?? row.open_interest);
    if (timestamp === null || openInterest === null) return [];
    return [{
      symbol,
      source_timestamp: timestamp,
      availability_timestamp: timestamp,
      create_time: timestamp,
      open_interest: openInterest,
      sum_open_interest: openInterest,
      open_interest_value: finite(row.sum_open_interest_value ?? row.open_interest_value),
      sum_open_interest_value: finite(row.sum_open_interest_value),
      top_trader_long_short_ratio: finite(row.sum_toptrader_long_short_ratio),
      global_long_short_ratio: finite(row.count_long_short_ratio),
      taker_long_short_volume_ratio: finite(row.sum_taker_long_short_vol_ratio),
    }];
  });
}

// The public metrics archive is typically much denser than the hourly signal
// clock. Keep the latest source row in each UTC hour without changing its
// source/availability timestamps. This bounds memory while preserving a
// conservative point-in-time lookup (a future row can never replace a prior
// row).
function latestMetricsPerHour(rows = []) {
  const byHour = new Map();
  for (const row of rows) {
    const bucket = Math.floor(row.source_timestamp / HOUR) * HOUR;
    const current = byHour.get(bucket);
    if (!current || row.source_timestamp > current.source_timestamp) byHour.set(bucket, row);
  }
  return [...byHour.values()].sort((left, right) => left.source_timestamp - right.source_timestamp);
}

async function fetchArchive(url, fetchImpl, {
  requestTimeoutMs = 30000,
  maxRetries = 2,
} = {}) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, { signal: controller.signal });
      if (response.status === 404) return { url, missing: true, rows: [] };
      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 429 || response.status >= 500;
        if (!retryable || attempt === maxRetries) {
          throw new Error(`Binance derivatives archive request failed: ${response.status} ${url}`);
        }
        throw new Error(`retryable_http_${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      return { url, missing: false, bytes };
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError || new Error(`Binance derivatives archive request failed: ${url}`);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = Array(items.length);
  let next = 0;
  const workerCount = Math.min(Math.max(1, concurrency), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  }));
  return results;
}

async function loadMonthlyFamily({
  symbol,
  family,
  startTime,
  endTime,
  timeframe = null,
  parser,
  concurrency,
  fetchImpl,
  requestTimeoutMs,
  maxRetries,
}) {
  const months = monthList(startTime, endTime);
  const pages = await mapWithConcurrency(months, concurrency, async month => {
    const path = timeframe
      ? `monthly/${family}/${symbol}/${timeframe}/${symbol}-${timeframe}-${month}.zip`
      : `monthly/${family}/${symbol}/${symbol}-${family}-${month}.zip`;
    const result = await fetchArchive(`${BINANCE_DERIVATIVES_ARCHIVE_BASE}/${path}`, fetchImpl, {
      requestTimeoutMs,
      maxRetries,
    });
    if (result.missing) return { month, missing: true, rows: [] };
    const csv = readArchiveEntry(result.bytes);
    return { month, missing: false, rows: parser(csv, symbol) };
  });
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  return {
    rows: pages.flatMap(page => page.rows)
      .filter(row => row.source_timestamp >= start && row.source_timestamp <= end)
      .sort((left, right) => left.source_timestamp - right.source_timestamp),
    files: {
      expected: months.length,
      loaded: pages.filter(page => !page.missing).length,
      missing: pages.filter(page => page.missing).map(page => page.month),
    },
  };
}

async function loadMetricsFamily({
  symbol,
  startTime,
  endTime,
  concurrency,
  fetchImpl,
  requestTimeoutMs,
  maxRetries,
}) {
  const dates = dateList(startTime, endTime);
  const pages = await mapWithConcurrency(dates, concurrency, async date => {
    const path = `daily/metrics/${symbol}/${symbol}-metrics-${date}.zip`;
    const result = await fetchArchive(`${BINANCE_DERIVATIVES_ARCHIVE_BASE}/${path}`, fetchImpl, {
      requestTimeoutMs,
      maxRetries,
    });
    if (result.missing) return { date, missing: true, rows: [] };
    const csv = readArchiveEntry(result.bytes);
    return { date, missing: false, rows: parseMetricsRows(csv, symbol) };
  });
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  return {
    rows: latestMetricsPerHour(pages.flatMap(page => page.rows)
      .filter(row => row.source_timestamp >= start && row.source_timestamp <= end)),
    files: {
      expected: dates.length,
      loaded: pages.filter(page => !page.missing).length,
      missing: pages.filter(page => page.missing).map(page => page.date),
    },
  };
}

async function loadForSymbol(symbol, options) {
  const [funding, premium, openInterest] = await Promise.all([
    loadMonthlyFamily({
      ...options,
      symbol,
      family: 'fundingRate',
      parser: parseFundingRows,
    }),
    loadMonthlyFamily({
      ...options,
      symbol,
      family: 'premiumIndexKlines',
      timeframe: '1h',
      parser: parsePremiumRows,
    }),
    loadMetricsFamily({ ...options, symbol }),
  ]);
  return { symbol, funding, premium, openInterest };
}

/** Load reproducible public derivative histories for research only. */
export async function loadPublicDerivativeHistory({
  symbols = [],
  startTime,
  endTime,
  concurrency = 8,
  symbolConcurrency = 2,
  requestTimeoutMs = 30000,
  maxRetries = 2,
  onSymbolComplete = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const start = timestampValue(startTime);
  const end = timestampValue(endTime);
  if (start === null || end === null || end < start || !symbols.length) {
    throw new Error('Derivative history requires symbols, startTime and endTime');
  }
  const normalizedSymbols = [...new Set(symbols.map(symbol => String(symbol).toUpperCase()))].sort();
  const results = await mapWithConcurrency(normalizedSymbols, symbolConcurrency, symbol => (
    loadForSymbol(symbol, {
      startTime: start,
      endTime: end,
      concurrency,
      requestTimeoutMs,
      maxRetries,
      fetchImpl,
    }).then(result => {
      if (typeof onSymbolComplete === 'function') onSymbolComplete(result);
      return result;
    })
  ));
  return {
    source: 'public_binance_futures_archive',
    requested_start: start,
    requested_end: end,
    fundingBySymbol: Object.fromEntries(results.map(result => [result.symbol, result.funding.rows])),
    premiumBySymbol: Object.fromEntries(results.map(result => [result.symbol, result.premium.rows])),
    openInterestBySymbol: Object.fromEntries(results.map(result => [result.symbol, result.openInterest.rows])),
    files: {
      Funding: Object.fromEntries(results.map(result => [result.symbol, result.funding.files])),
      'Basis/Premium': Object.fromEntries(results.map(result => [result.symbol, result.premium.files])),
      'Open Interest': Object.fromEntries(results.map(result => [result.symbol, result.openInterest.files])),
    },
  };
}

export {
  latestMetricsPerHour,
  parseCsvRows,
  parseFundingRows,
  parseMetricsRows,
  parsePremiumRows,
};

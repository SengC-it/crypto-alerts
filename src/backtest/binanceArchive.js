// Binance public-data archive loader for environments where the Futures REST
// endpoint is location-restricted. This is read-only historical data; it does
// not use credentials or private exchange permissions.

import { inflateRawSync } from 'node:zlib';
import { intervalToMs, normalizeCandle } from '../market/candle.js';

export const BINANCE_PUBLIC_ARCHIVE_BASE = 'https://data.binance.vision/data/futures/um/daily/klines';

const DAY = 24 * 60 * 60 * 1000;

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function datePart(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function readArchiveEntry(zipBytes) {
  const bytes = Buffer.from(zipBytes);
  let endRecord = -1;
  for (let offset = bytes.length - 22; offset >= 0; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      endRecord = offset;
      break;
    }
  }
  if (endRecord < 0) throw new Error('Binance archive is not a ZIP file');

  const entryCount = bytes.readUInt16LE(endRecord + 10);
  const centralDirectoryOffset = bytes.readUInt32LE(endRecord + 16);
  let cursor = centralDirectoryOffset;
  for (let index = 0; index < entryCount; index += 1) {
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Binance archive central directory is invalid');
    }
    const method = bytes.readUInt16LE(cursor + 10);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
    const name = bytes.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    const localNameLength = bytes.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = bytes.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = bytes.subarray(dataStart, dataStart + compressedSize);
    let content;
    if (method === 0) content = compressed;
    else if (method === 8) content = inflateRawSync(compressed);
    else throw new Error(`Unsupported Binance archive compression method: ${method}`);
    if (name.toLowerCase().endsWith('.csv')) return content.toString('utf8');
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error('Binance archive does not contain a CSV entry');
}

function parseArchiveCsv(csv, symbol, timeframe) {
  return csv.split(/\r?\n/).flatMap(line => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.toLowerCase().startsWith('open_time,')) return [];
    const fields = trimmed.split(',');
    if (fields.length < 7 || !Number.isFinite(Number(fields[0]))) return [];
    const row = [
      fields[0], fields[1], fields[2], fields[3], fields[4], fields[5],
      fields[6], fields[7], fields[8], fields[9], fields[10], fields[11],
    ];
    return [normalizeCandle(row, {
      symbol,
      timeframe,
      now: Number.POSITIVE_INFINITY,
      isClosed: true,
    })];
  });
}

async function fetchDailyArchive(symbol, timeframe, date, fetchImpl) {
  const file = `${symbol}-${timeframe}-${date}.zip`;
  const url = `${BINANCE_PUBLIC_ARCHIVE_BASE}/${symbol}/${timeframe}/${file}`;
  const response = await fetchImpl(url);
  if (response.status === 404) return { date, candles: [], missing: true };
  if (!response.ok) throw new Error(`Binance public archive request failed: ${response.status} ${url}`);
  const bytes = await response.arrayBuffer();
  return {
    date,
    candles: parseArchiveCsv(readArchiveEntry(bytes), symbol, timeframe),
    missing: false,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await worker(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

/** Use the latest fully completed UTC day for the public daily archive. */
export function archiveAsOf(now = Date.now()) {
  const timestamp = finite(now);
  if (timestamp === null) throw new Error(`Invalid archive as-of time: ${now}`);
  return Math.floor(timestamp / DAY) * DAY - 1;
}

/**
 * Load daily Binance Futures public archives covering an exact time range.
 * Missing archive days are returned for auditability and are also caught by
 * loadBacktestHistory's strict candle coverage gate.
 */
export async function loadBinanceVisionCandles({
  symbol,
  timeframe = '1h',
  startTime,
  endTime,
  concurrency = 8,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('A fetch implementation is required');
  const step = intervalToMs(timeframe);
  const start = finite(startTime);
  const end = finite(endTime);
  if (!symbol || start === null || end === null || end < start) {
    throw new Error('Binance archive requires symbol, startTime and endTime');
  }
  const dates = [];
  for (let timestamp = Math.floor(start / DAY) * DAY; timestamp <= end; timestamp += DAY) {
    dates.push(datePart(timestamp));
  }
  const pages = await mapWithConcurrency(dates, concurrency, date => (
    fetchDailyArchive(symbol.toUpperCase(), timeframe, date, fetchImpl)
  ));
  const candles = pages
    .flatMap(page => page.candles)
    .filter(candle => candle.open_time >= start - step && candle.open_time <= end)
    .sort((left, right) => left.open_time - right.open_time);
  return {
    candles,
    requested_start: start,
    requested_end: end,
    archive_dates: dates,
    missing_archive_dates: pages.filter(page => page.missing).map(page => page.date),
  };
}

export { parseArchiveCsv, readArchiveEntry };

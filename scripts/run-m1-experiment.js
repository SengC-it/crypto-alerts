// Run the M1 experiment against public Binance Futures history or an offline
// deterministic fixture. This script never writes production data.

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG, getIndicatorLookback } from '../src/config.js';
import { archiveAsOf, loadBinanceVisionCandles } from '../src/backtest/binanceArchive.js';
import { loadBacktestHistory, requestedWindow } from '../src/backtest/history.js';
import { buildM1Markdown } from '../src/v2/report.js';
import { runM1Experiment } from '../src/v2/experiment.js';

const HOUR = 60 * 60 * 1000;

function argument(name, fallback = null) {
  const prefix = `--${name}=`;
  const match = process.argv.find(value => value.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function makeFixture(symbol, count = 900, phase = 0) {
  const start = Date.UTC(2025, 0, 1);
  return Array.from({ length: count }, (_, index) => {
    const cycle = Math.floor(index / 150) % 3;
    const slope = cycle === 0 ? 0.0012 : cycle === 1 ? -0.001 : 0.0001;
    const base = 100 * Math.exp(slope * index / 4) + Math.sin((index + phase) / 9) * 1.5;
    const close = Math.max(1, base + Math.sin(index / 3 + phase) * (cycle === 2 ? 0.8 : 0.25));
    const open = index ? (100 * Math.exp(slope * (index - 1) / 4) + Math.sin((index - 1 + phase) / 9) * 1.5) : close;
    const spread = cycle === 2 ? 2.2 : 0.7;
    return {
      open,
      high: Math.max(open, close) + spread,
      low: Math.min(open, close) - spread,
      close,
      volume: 1000 + (index % 17) * 40 + (cycle === 0 ? 100 : 0),
      quote_volume: close * (1000 + (index % 17) * 40),
      open_time: start + index * HOUR,
      close_time: start + (index + 1) * HOUR - 1,
      timeframe: '1h',
      is_closed: true,
      symbol,
    };
  });
}

function compactResult(result) {
  if (process.argv.includes('--full')) return result;
  const compactWalkForward = result.walk_forward
    ? {
      ...result.walk_forward,
      windows: (result.walk_forward.windows || []).map(({ train, test, ...window }) => window),
      oos_samples_count: result.walk_forward.oos_samples?.length || 0,
      oos_samples: undefined,
    }
    : result.walk_forward;
  return {
    ...result,
    candidates: undefined,
    candidate_count: result.candidate_count ?? (result.candidates?.length || 0),
    v1_records: undefined,
    v1_record_count: result.v1_record_count ?? (result.v1_records?.length || 0),
    v2_records: undefined,
    v2_record_count: result.v2_record_count ?? (result.v2_records?.length || 0),
    oos_records: undefined,
    oos_record_count: result.oos_record_count ?? (result.oos_records?.length || 0),
    walk_forward: compactWalkForward,
  };
}

async function loadLive(symbols, days, asOf, source = 'rest') {
  const bySymbol = {};
  const window = requestedWindow(days, { asOf, timeframe: '1h' });
  const archiveStart = window.startOpen - getIndicatorLookback(CONFIG) * HOUR;
  for (let index = 0; index < symbols.length; index += 4) {
    const batch = symbols.slice(index, index + 4);
    const results = await Promise.all(batch.map(async symbol => {
      const candles = source === 'archive'
        ? (await loadBinanceVisionCandles({
          symbol,
          timeframe: '1h',
          startTime: archiveStart,
          endTime: window.requestedEnd,
          concurrency: 8,
        })).candles
        : undefined;
      const history = await loadBacktestHistory(symbol, days, {
        config: CONFIG,
        asOf,
        strictCoverage: true,
        candles,
      });
      return [symbol, history.candles];
    }));
    for (const [symbol, candles] of results) bySymbol[symbol] = candles;
  }
  return bySymbol;
}

const archive = process.argv.includes('--archive');
const live = process.argv.includes('--live') || archive;
const days = Number(argument('days', '30'));
const requestedSymbols = argument('symbols');
const symbols = (requestedSymbols
  ? requestedSymbols.split(',')
  : CONFIG.BINANCE_SYMBOLS)
  .map(symbol => symbol.toUpperCase().trim())
  .filter(Boolean);
const requestedAsOf = argument('as-of');
const parsedAsOf = requestedAsOf ? Date.parse(requestedAsOf) : null;
if (requestedAsOf && !Number.isFinite(parsedAsOf)) throw new Error(`Invalid --as-of value: ${requestedAsOf}`);
const asOf = parsedAsOf ?? (archive ? archiveAsOf(Date.now()) : Date.now());
const dataSource = archive
  ? 'public_binance_futures_archive'
  : live ? 'public_binance_futures' : 'deterministic_fixture';
const candlesBySymbol = live
  ? await loadLive(symbols, days, asOf, archive ? 'archive' : 'rest')
  : Object.fromEntries(symbols.map((symbol, index) => [symbol, makeFixture(symbol, Math.max(900, days * 24 + 150), index)]));
const result = runM1Experiment({
  candlesBySymbol,
  config: CONFIG,
  asOf,
  dataSource,
  includeArtifacts: process.argv.includes('--full'),
  experimentId: argument('experiment', `m1-${dataSource}-${new Date(asOf).toISOString().slice(0, 10)}`),
});

const outputPath = argument('out');
if (outputPath) {
  fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(compactResult(result), null, 2));
  const markdownPath = outputPath.replace(/\.json$/i, '.md');
  fs.writeFileSync(markdownPath, buildM1Markdown(result));
}

console.log(JSON.stringify({
  experiment_id: result.experiment_id,
  model_version: result.model_version,
  data_source: result.benchmark.data_source,
  symbols: result.benchmark.symbols,
  historical_coverage: result.historical_coverage,
  mode: result.mode,
  candidate_count: result.candidate_count ?? result.candidates.length,
  walk_forward: {
    status: result.walk_forward.status,
    windows: result.walk_forward.window_count,
    positive_windows: result.walk_forward.positive_windows,
    final_holdout_count: result.walk_forward.final_holdout_count,
    final_holdout_untouched: result.walk_forward.final_holdout_untouched,
  },
  metrics: result.metrics.v2,
  comparison: result.comparison,
  calibration: result.calibration,
  promotion: result.promotion,
}, null, 2));

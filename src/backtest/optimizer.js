import { backtestAll } from './engine.js';

function setNestedValue(target, dottedKey, value) {
  const parts = dottedKey.split('.');
  let cursor = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    cursor[part] = cursor[part] || {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

export function generateParameterGrid(candidates) {
  const entries = Object.entries(candidates).filter(([, values]) => Array.isArray(values) && values.length > 0);
  if (entries.length === 0) return [];

  const scenarios = [];
  function visit(index, options) {
    if (index === entries.length) {
      const id = Object.entries(options).map(([k, v]) => `${k}=${v}`).join('__');
      const expandedOptions = {};
      for (const [key, value] of Object.entries(options)) {
        if (key.includes('.')) setNestedValue(expandedOptions, key, value);
        else expandedOptions[key] = value;
      }
      scenarios.push({ id, options: expandedOptions });
      return;
    }

    const [key, values] = entries[index];
    for (const value of values) {
      visit(index + 1, { ...options, [key]: value });
    }
  }

  visit(0, {});
  return scenarios;
}

export function summarizeBacktestResult(result) {
  const usable = (result.results || []).filter(r => !r.error && r.totalTrades > 0);
  const avg = field => usable.length
    ? usable.reduce((sum, r) => sum + (Number(r[field]) || 0), 0) / usable.length
    : 0;

  return {
    usableSymbols: usable.length,
    totalTrades: usable.reduce((sum, r) => sum + (r.totalTrades || 0), 0),
    avgNetPnlPercent: +avg('totalPnlPercent').toFixed(2),
    avgGrossPnlPercent: +avg('grossPnlPercent').toFixed(2),
    avgCostPercent: +avg('totalCostPercent').toFixed(2),
    avgWinRate: +avg('winRate').toFixed(1),
    avgProfitFactor: +avg('profitFactor').toFixed(2),
    avgMaxDrawdownPercent: +avg('maxDrawdownPercent').toFixed(2),
  };
}

export function scoreSummary(summary) {
  const net = summary.avgNetPnlPercent || 0;
  const profitFactorBonus = Math.min(summary.avgProfitFactor || 0, 5) * 4;
  const winRateBonus = (summary.avgWinRate || 0) / 10;
  const drawdownPenalty = (summary.avgMaxDrawdownPercent || 0) * 1.5;
  const activityPenalty = summary.totalTrades > 0 ? 0 : 100;
  return +(net + profitFactorBonus + winRateBonus - drawdownPenalty - activityPenalty).toFixed(2);
}

export function rankOptimizationResults(results) {
  return results
    .map(result => ({ ...result, score: scoreSummary(result.summary || {}) }))
    .sort((a, b) => b.score - a.score);
}

export async function runOptimizationGrid({
  days = 30,
  candidates,
  baseOptions = {},
  backtestFn = backtestAll,
  includeBacktest = false,
}) {
  const scenarios = generateParameterGrid(candidates);
  const results = [];

  for (const scenario of scenarios) {
    const backtest = await backtestFn(days, { ...baseOptions, ...scenario.options });
    const item = {
      id: scenario.id,
      options: scenario.options,
      summary: summarizeBacktestResult(backtest),
      dataQuality: {
        totalSymbols: backtest.totalSymbols || 0,
        errors: backtest.errors?.length || 0,
      },
    };
    if (includeBacktest) item.backtest = backtest;
    results.push(item);
  }

  return rankOptimizationResults(results);
}

import { backtestAll } from './engine.js';
import { hashConfig, stableStringify } from '../lineage.js';

const EXECUTION_OPTION_KEYS = [
  'minConfidence',
  'noConflictFilter',
  'boostResonance',
  'usePosition',
  'leverage',
  'initialCapital',
  'stopLossATR',
  'takeProfitATR',
  'trailingStop',
  'trailingATR',
  'roundTripCostPercent',
  'profitFilter',
  'positionTimeoutHours',
  'cooldownMinutes',
  'tier',
  'strategyOverrides',
  'strictCoverage',
  'asOf',
  'warmup',
  'config',
];

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

function mergeStrategyOverrides(base = {}, candidate = {}) {
  const merged = { ...base };
  for (const [strategy, override] of Object.entries(candidate)) {
    const baseOverride = base[strategy] || {};
    const candidateOverride = override || {};
    merged[strategy] = { ...baseOverride, ...candidateOverride };
    if (baseOverride.params || candidateOverride.params) {
      merged[strategy].params = {
        ...(baseOverride.params || {}),
        ...(candidateOverride.params || {}),
      };
    }
  }
  return merged;
}

function mergeExecutionOptions(baseOptions, candidateOptions) {
  const merged = { ...baseOptions, ...candidateOptions };
  if (baseOptions.strategyOverrides || candidateOptions.strategyOverrides) {
    merged.strategyOverrides = mergeStrategyOverrides(
      baseOptions.strategyOverrides,
      candidateOptions.strategyOverrides,
    );
  }
  return merged;
}

function executionConfigProjection(options) {
  return Object.fromEntries(EXECUTION_OPTION_KEYS
    .filter(key => options[key] !== undefined)
    .map(key => [key, options[key]]));
}

export function optimizationOutputProjection(backtest) {
  return {
    totalSymbols: backtest.totalSymbols || 0,
    totalTrades: backtest.totalTrades || 0,
    errors: (backtest.errors || []).map(error => ({
      symbol: error.symbol,
      error: error.error,
      coverage: error.coverage,
    })),
    results: (backtest.results || [])
      .map(result => ({
        symbol: result.symbol,
        totalTrades: result.totalTrades || 0,
        rawSignalCount: result.rawSignalCount || 0,
        filteredSignalCount: result.filteredSignalCount || 0,
        totalPnlPercent: result.totalPnlPercent || 0,
        winRate: result.winRate || 0,
        profitFactor: result.profitFactor || 0,
        maxDrawdownPercent: result.maxDrawdownPercent || 0,
        trades: (result.trades || []).map(trade => ({
          direction: trade.direction,
          strategy: trade.strategy,
          entry: trade.entry,
          exit: trade.exit,
          stopLoss: trade.stopLoss,
          target: trade.target,
          exitReason: trade.exitReason,
          pnl: trade.pnl,
          signalTimestamp: trade.signalTimestamp,
        })),
        signalEvaluations: (result.signalEvaluations || []).map(evaluation => ({
          strategy: evaluation.strategy,
          direction: evaluation.direction,
          signal_timestamp: evaluation.signal_timestamp,
          entry_price: evaluation.entry_price,
          fee_slippage_cost_percent: evaluation.fee_slippage_cost_percent,
          forward_returns: evaluation.forward_returns,
          net_forward_returns: evaluation.net_forward_returns,
          mfe_percent: evaluation.mfe_percent,
          mae_percent: evaluation.mae_percent,
          tp_sl_outcome: evaluation.tp_sl_outcome,
        })),
      }))
      .sort((a, b) => String(a.symbol).localeCompare(String(b.symbol))),
  };
}

function valueAt(options, dottedKey) {
  return dottedKey.split('.').reduce((value, key) => value?.[key], options);
}

export function analyzeParameterEffects(results, candidates) {
  const parameterKeys = Object.keys(candidates || {});
  const effects = parameterKeys.map(parameter => {
    const otherParameters = parameterKeys.filter(key => key !== parameter);
    const comparablePairs = [];

    for (let left = 0; left < results.length; left++) {
      for (let right = left + 1; right < results.length; right++) {
        const sameOtherParameters = otherParameters.every(key => {
          return stableStringify(valueAt(results[left].options, key))
            === stableStringify(valueAt(results[right].options, key));
        });
        const parameterChanged = stableStringify(valueAt(results[left].options, parameter))
          !== stableStringify(valueAt(results[right].options, parameter));
        if (sameOtherParameters && parameterChanged) {
          comparablePairs.push([results[left], results[right]]);
        }
      }
    }

    const effectiveChanged = comparablePairs.some(([left, right]) => {
      return left.effectiveConfigHash !== right.effectiveConfigHash;
    });
    const outputChanged = comparablePairs.some(([left, right]) => {
      return left.outputHash !== right.outputHash;
    });
    return {
      parameter,
      pairsCompared: comparablePairs.length,
      effectiveChanged,
      outputChanged,
      passed: comparablePairs.length > 0 && effectiveChanged && outputChanged,
    };
  });

  return {
    passed: effects.length > 0 && effects.every(effect => effect.passed),
    effects,
  };
}

export function detectOptimizationNoOps(results) {
  const firstByOutput = new Map();
  const noOps = [];
  for (const result of results) {
    const previous = firstByOutput.get(result.outputHash);
    if (previous && stableStringify(previous.options) !== stableStringify(result.options)) {
      noOps.push({
        first: { id: previous.id, options: previous.options },
        second: { id: result.id, options: result.options },
        outputHash: result.outputHash,
      });
    } else if (!previous) {
      firstByOutput.set(result.outputHash, result);
    }
  }
  return { passed: noOps.length === 0, noOps };
}

function assertValidCandidateSpace(candidates, baseOptions) {
  if (!Array.isArray(candidates?.trailingATR) || candidates.trailingATR.length === 0) return;
  const trailingCandidates = candidates.trailingStop;
  const alwaysEnabled = Array.isArray(trailingCandidates) && trailingCandidates.length > 0
    ? trailingCandidates.every(value => value === true)
    : baseOptions.trailingStop === true;
  if (!alwaysEnabled) {
    throw new Error('trailingATR requires trailingStop=true for every optimization scenario');
  }
}

export async function runOptimizationGrid({
  days = 30,
  candidates,
  baseOptions = {},
  backtestFn = backtestAll,
  includeBacktest = false,
  returnAnalysis = false,
  failOnNoOp = false,
}) {
  assertValidCandidateSpace(candidates, baseOptions);
  const scenarios = generateParameterGrid(candidates);
  const results = [];

  for (const scenario of scenarios) {
    const executionOptions = mergeExecutionOptions(baseOptions, scenario.options);
    const backtest = await backtestFn(days, executionOptions);
    const output = optimizationOutputProjection(backtest);
    const item = {
      id: scenario.id,
      options: scenario.options,
      effectiveConfigHash: hashConfig(executionConfigProjection(executionOptions)),
      outputHash: hashConfig(output),
      summary: summarizeBacktestResult(backtest),
      dataQuality: {
        totalSymbols: backtest.totalSymbols || 0,
        errors: backtest.errors?.length || 0,
      },
    };
    if (includeBacktest) item.backtest = backtest;
    results.push(item);
  }

  const ranked = rankOptimizationResults(results);
  if (!returnAnalysis && !failOnNoOp) return ranked;

  const parameterEffect = analyzeParameterEffects(results, candidates);
  const noOp = detectOptimizationNoOps(results);
  const analysis = { ranked, parameterEffect, noOp };
  if (failOnNoOp && (!parameterEffect.passed || !noOp.passed)) {
    const error = new Error('Optimizer parameter-effect or no-op validation failed');
    error.analysis = analysis;
    throw error;
  }
  return analysis;
}

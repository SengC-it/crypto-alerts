// V1/V2 comparison contract. The caller must provide one immutable benchmark
// specification for both lanes.

import { stableStringify } from '../lineage.js';
import { summarizeEvaluations } from './metrics.js';

export function assertBenchmarkParity(v1Benchmark, v2Benchmark) {
  const fields = ['symbols', 'candles', 'evaluation_horizons', 'fees', 'slippage', 'market_event_window_hours', 'date_range'];
  for (const field of fields) {
    if (stableStringify(v1Benchmark?.[field]) !== stableStringify(v2Benchmark?.[field])) {
      throw new Error(`V1/V2 benchmark mismatch: ${field}`);
    }
  }
  return true;
}

export function compareV1V2({
  benchmark,
  v1Benchmark = benchmark,
  v2Benchmark = benchmark,
  v1Records = [],
  v2Records = [],
} = {}) {
  assertBenchmarkParity(v1Benchmark, v2Benchmark);
  const v1 = summarizeEvaluations(v1Records);
  const v2 = summarizeEvaluations(v2Records);
  return {
    benchmark: v1Benchmark,
    v1,
    v2,
    delta: {
      net_expectancy_percent: v2.net_expectancy_percent === null || v1.net_expectancy_percent === null
        ? null
        : +(v2.net_expectancy_percent - v1.net_expectancy_percent).toFixed(6),
      net_profit_factor: v2.net_profit_factor === null || v1.net_profit_factor === null
        ? null
        : +(v2.net_profit_factor - v1.net_profit_factor).toFixed(6),
      evaluated_count: v2.evaluated_count - v1.evaluated_count,
    },
    same_data_contract: true,
  };
}

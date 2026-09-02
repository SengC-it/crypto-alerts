// V1/V2 comparison contract. The caller must provide one immutable benchmark
// specification for both lanes.

import { stableStringify } from '../lineage.js';
import { summarizeEvaluations } from './metrics.js';

function uniqueEvents(records) {
  return new Set((records || []).map(record => record.market_event_id ?? record.signal?.market_event_id).filter(Boolean));
}

function reductionPercent(from, to) {
  return from > 0 ? +((from - to) / from * 100).toFixed(4) : null;
}

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
  selection = {},
} = {}) {
  assertBenchmarkParity(v1Benchmark, v2Benchmark);
  const v1 = summarizeEvaluations(v1Records);
  const v2 = summarizeEvaluations(v2Records);
  const v1Signals = v1Records.length;
  const v1IndependentClusters = uniqueEvents(v1Records).size;
  const v2AllCandidates = selection.oos?.all_candidates ?? selection.all_candidates ?? v2Records.length;
  const v2EligibleCandidates = selection.oos?.score_eligible_candidates
    ?? selection.score_eligible_candidates
    ?? v2Records.length;
  const v2SelectedCandidates = selection.oos?.cluster_selected_candidates
    ?? selection.cluster_selected_candidates
    ?? v2Records.length;
  const v2SelectedClusters = uniqueEvents(v2Records).size;
  return {
    benchmark: v1Benchmark,
    v1,
    v2,
    counts: {
      v1_signals: v1Signals,
      v1_independent_clusters: v1IndependentClusters,
      v2_all_candidates: v2AllCandidates,
      v2_eligible_candidates: v2EligibleCandidates,
      v2_selected_candidates: v2SelectedCandidates,
      v2_selected_independent_clusters: v2SelectedClusters,
      v2_all_to_selected_reduction_percent: reductionPercent(v2AllCandidates, v2SelectedCandidates),
      v2_eligible_to_selected_reduction_percent: reductionPercent(v2EligibleCandidates, v2SelectedCandidates),
    },
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
    same_market_event_definition: true,
  };
}

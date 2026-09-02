// M1 promotion decision. Thresholds are fixed and are never reduced to make a
// dataset pass.

export const PROMOTION_THRESHOLDS = Object.freeze({
  independentClusters: 100,
  netProfitFactor: 1.25,
  netExpectancyPercent: 0.15,
  oosWindows: 6,
  positiveWindows: 4,
  symbolBreadth: 8,
});

export function evaluatePromotionGate({
  metrics = {},
  walkForward = {},
  calibration = metrics.score_calibration,
  thresholds = PROMOTION_THRESHOLDS,
  dataSource = 'unknown',
} = {}) {
  const observed = {
    independent_clusters: metrics.independent_market_clusters || 0,
    net_profit_factor: metrics.net_profit_factor || 0,
    net_expectancy_percent: metrics.net_expectancy_percent || 0,
    oos_windows: walkForward.window_count || 0,
    positive_windows: walkForward.positive_windows || 0,
    symbol_breadth: metrics.symbol_breadth || 0,
  };
  const failures = [];
  if (observed.independent_clusters < thresholds.independentClusters) failures.push('independent_clusters');
  if (observed.net_profit_factor < thresholds.netProfitFactor) failures.push('net_profit_factor');
  if (observed.net_expectancy_percent < thresholds.netExpectancyPercent) failures.push('net_expectancy_percent');
  if (observed.oos_windows < thresholds.oosWindows) failures.push('oos_windows');
  if (observed.positive_windows < thresholds.positiveWindows) failures.push('positive_windows');
  if (observed.symbol_breadth < thresholds.symbolBreadth) failures.push('symbol_breadth');
  if (calibration?.status !== 'PASS') failures.push('calibration');

  const publicBinanceSource = String(dataSource).startsWith('public_binance_futures');
  const evidenceInsufficient = !publicBinanceSource
    || observed.independent_clusters < thresholds.independentClusters
    || observed.oos_windows < thresholds.oosWindows
    || observed.symbol_breadth < thresholds.symbolBreadth
    || (metrics.evaluated_count || 0) < thresholds.independentClusters;
  const recommendation = evidenceInsufficient
    ? 'INSUFFICIENT_EVIDENCE'
    : failures.length
      ? 'REJECT'
      : 'SHADOW_CANDIDATE';
  return {
    recommendation,
    thresholds,
    observed,
    failures,
    calibration_status: calibration?.status || 'CALIBRATION_FAIL',
    data_source: dataSource,
    no_threshold_reduction: true,
  };
}

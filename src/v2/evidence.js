// Independent evidence groups for V2. Correlated indicators are deliberately
// collapsed before scoring so indicator count cannot masquerade as evidence.

import { candleReturnPercent, mean, median } from './canonical.js';

export const EVIDENCE_GROUPS = Object.freeze([
  'Trend',
  'Momentum',
  'Participation',
  'Volatility',
  'Market Structure',
  'Higher Timeframe',
]);

const DEFAULT_GROUP_WEIGHTS = Object.freeze({
  Trend: 0.22,
  Momentum: 0.18,
  Participation: 0.14,
  Volatility: 0.14,
  'Market Structure': 0.18,
  'Higher Timeframe': 0.14,
});

function finite(value) {
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function directionSign(direction) {
  return String(direction || '').toUpperCase() === 'SELL' ? -1 : 1;
}

function clamp(value, minimum = -1, maximum = 1) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedStrength(value, direction, directional = true) {
  const numeric = finite(value);
  if (numeric === null) return 0;
  const signed = Math.abs(numeric) <= 1 ? numeric : numeric / 100;
  return clamp(directional ? signed * directionSign(direction) : signed);
}

function groupForSource(source = '') {
  const key = String(source).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (/(ema|sma|movingaverage|trend)/.test(key)) return 'Trend';
  if (/(macd|rsi|stochastic|momentum|roc)/.test(key)) return 'Momentum';
  if (/(volume|participation|openinterest|funding|spread|liquidity)/.test(key)) return 'Participation';
  if (/(atr|natr|volatility)/.test(key)) return 'Volatility';
  if (/(donchian|structure|breakout|range)/.test(key)) return 'Market Structure';
  if (/(higher|context|4h|timeframe)/.test(key)) return 'Higher Timeframe';
  return null;
}

function independentKey(group, source = '') {
  const sourceGroup = groupForSource(source);
  if (sourceGroup === 'Trend') return 'moving-average-trend-family';
  if (sourceGroup === 'Momentum') return 'momentum-family';
  if (sourceGroup === 'Participation') return 'participation-family';
  if (sourceGroup === 'Volatility') return 'volatility-family';
  if (sourceGroup === 'Market Structure') return 'market-structure-family';
  if (sourceGroup === 'Higher Timeframe') return 'higher-timeframe-family';
  return `${group}:${source}`;
}

function candidateEvidence({ group, source, strength, direction, reason, value, weight, directional = true }) {
  const normalizedGroup = EVIDENCE_GROUPS.includes(group) ? group : groupForSource(source);
  if (!normalizedGroup) return null;
  return {
    group: normalizedGroup,
    source: source || normalizedGroup,
    independent_key: independentKey(normalizedGroup, source),
    strength: +normalizedStrength(strength, direction, directional).toFixed(6),
    directional,
    value: value ?? null,
    weight: weight ?? DEFAULT_GROUP_WEIGHTS[normalizedGroup],
    reason: reason || null,
  };
}

/**
 * Keep one representative per evidence group. The returned rejected list is
 * retained for auditability, rather than silently discarding correlated data.
 */
export function deduplicateEvidence(entries = []) {
  const usable = entries.map(entry => {
    if (!entry || typeof entry !== 'object') return null;
    return candidateEvidence({
      ...entry,
      group: entry.group || groupForSource(entry.source),
    });
  }).filter(Boolean);
  const accepted = [];
  const rejected = [];
  const bestByGroup = new Map();

  for (const entry of usable) {
    const existing = bestByGroup.get(entry.group);
    if (!existing || Math.abs(entry.strength) > Math.abs(existing.strength)) {
      if (existing) rejected.push({ ...existing, rejected_reason: 'CORRELATED_GROUP_REPRESENTATIVE' });
      bestByGroup.set(entry.group, entry);
    } else {
      rejected.push({ ...entry, rejected_reason: 'CORRELATED_GROUP_REPRESENTATIVE' });
    }
  }
  for (const group of EVIDENCE_GROUPS) {
    if (bestByGroup.has(group)) accepted.push(bestByGroup.get(group));
  }
  return {
    accepted,
    rejected,
    groups_present: accepted.map(entry => entry.group),
    independent_group_count: accepted.length,
    group_count: EVIDENCE_GROUPS.length,
  };
}

function volumeStrength(candles) {
  const current = finite(candles.at(-1)?.volume);
  const prior = candles.slice(-21, -1).map(candle => finite(candle.volume)).filter(value => value !== null);
  if (current === null || !prior.length) return { strength: 0, value: null, reason: 'NO_VOLUME_REFERENCE' };
  const baseline = median(prior);
  const ratio = baseline ? current / baseline : 1;
  const directionalMove = candleReturnPercent(candles.at(-2), candles.at(-1));
  const aligned = directionalMove === null ? 0 : Math.sign(directionalMove);
  return {
    strength: clamp((ratio - 1) * 2 * (aligned || 1)),
    value: ratio,
    reason: 'Current volume relative to prior median and trigger direction',
  };
}

function momentumStrength(candles, indicators) {
  const current = finite(indicators?.rsi_14);
  const returnValue = candleReturnPercent(candles.at(-2), candles.at(-1));
  const rsiSignal = current === null ? 0 : (current - 50) / 50;
  const returnSignal = returnValue === null ? 0 : Math.sign(returnValue);
  return {
    strength: clamp(rsiSignal * 0.6 + returnSignal * 0.4),
    value: current,
    reason: 'RSI and trigger momentum collapsed into one momentum group',
  };
}

/** Build raw evidence, then collapse it into independent groups. */
export function buildIndependentEvidence({
  candles = [],
  indicators = {},
  regime = {},
  setup = {},
  publicData = {},
} = {}) {
  const direction = setup.direction;
  const contextAligned = regime.trend_regime === 'Sideways'
    ? setup.setup_family === 'Mean Reversion'
    : regime.trend_regime === (direction === 'BUY' ? 'Bull' : 'Bear');
  const trendOrientation = regime.trend_regime === 'Bull'
    ? 1
    : regime.trend_regime === 'Bear'
      ? -1
      : 0;
  const participation = volumeStrength(candles);
  const momentum = momentumStrength(candles, indicators);
  const raw = [
    {
      group: 'Trend',
      source: 'trend-structure',
      strength: trendOrientation,
      value: regime.trend_slope_percent,
      reason: 'Regime trend classification',
    },
    {
      group: 'Momentum',
      source: 'RSI + trigger-return',
      strength: momentum.strength,
      value: momentum.value,
      reason: momentum.reason,
    },
    {
      group: 'Participation',
      source: 'volume-participation',
      strength: participation.strength,
      value: participation.value,
      reason: participation.reason,
    },
    {
      group: 'Volatility',
      source: 'empirical-volatility-regime',
      strength: regime.volatility_regime === 'Extreme' ? -0.25 : 0.5,
      directional: false,
      value: regime.natr_percent,
      reason: 'Empirical prior-history volatility band; hypothesis only',
    },
    {
      group: 'Market Structure',
      source: setup.setup_family === 'Breakout' ? 'prior-structure-break' : 'setup-structure',
      strength: setup.direction === 'SELL' ? -1 : 1,
      value: setup.feature_values || null,
      reason: setup.reason,
    },
    {
      group: 'Higher Timeframe',
      source: '4h-context',
      strength: regime.trend_regime === 'Sideways'
        ? (contextAligned ? 1 : 0)
        : trendOrientation,
      directional: regime.trend_regime !== 'Sideways',
      value: regime.context_time,
      reason: 'Closed 4h context alignment',
    },
  ];

  // These fields are optional and are strictly public-data inputs. They do not
  // cause a private exchange client to be initialized.
  if (publicData.funding !== undefined) {
    raw.push({ group: 'Participation', source: 'public-funding', strength: publicData.funding, value: publicData.funding, reason: 'Optional public futures funding' });
  }
  if (publicData.openInterest !== undefined) {
    raw.push({ group: 'Participation', source: 'public-open-interest', strength: publicData.openInterest, value: publicData.openInterest, reason: 'Optional public futures open interest' });
  }
  if (publicData.quoteVolume !== undefined) {
    raw.push({ group: 'Participation', source: 'public-quote-volume', strength: publicData.quoteVolume, value: publicData.quoteVolume, reason: 'Optional public quote volume' });
  }
  if (publicData.spread !== undefined) {
    raw.push({ group: 'Participation', source: 'public-spread', strength: -Math.abs(publicData.spread), value: publicData.spread, reason: 'Optional public liquidity/spread' });
  }

  return deduplicateEvidence(raw.map(entry => ({ ...entry, direction })));
}

export function getEvidenceGroupWeights(overrides = {}) {
  return { ...DEFAULT_GROUP_WEIGHTS, ...overrides };
}

export { groupForSource, independentKey };

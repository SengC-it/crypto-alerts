const PRIORITY_TIERS = [
  {
    level: 'high',
    minConfidence: 75,
    label: 'High priority',
    description: 'Higher-confidence signal validated by 30/90/180 day scans; treat as the main action list.',
    rank: 2,
  },
  {
    level: 'watch',
    minConfidence: 50,
    label: 'Opportunity watch',
    description: 'Lower-confidence opportunity layer designed to avoid missing moves; wait for confirmation or use smaller size.',
    rank: 1,
  },
];

const DEFAULT_PRIORITY = {
  level: 'low',
  label: 'Low confidence',
  description: 'Below the active opportunity threshold.',
  rank: 0,
};

export function getSignalPriority(signal) {
  const confidence = Number(signal?.confidence || 0);
  return PRIORITY_TIERS.find(tier => confidence >= tier.minConfidence) || DEFAULT_PRIORITY;
}

export function annotateSignalPriority(signal) {
  const priority = getSignalPriority(signal);
  return {
    ...signal,
    priority: priority.level,
    priorityLabel: priority.label,
    priorityDescription: priority.description,
    priorityRank: priority.rank,
  };
}

export function annotateSignalPriorities(signals) {
  return signals
    .map(annotateSignalPriority)
    .sort((a, b) => (b.priorityRank - a.priorityRank) || ((b.confidence || 0) - (a.confidence || 0)));
}

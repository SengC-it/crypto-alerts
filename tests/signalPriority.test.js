import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { annotateSignalPriority, annotateSignalPriorities, getSignalPriority } from '../src/strategies/signalPriority.js';

describe('Signal priority tiers', () => {
  it('marks confidence 75+ as high priority', () => {
    const priority = getSignalPriority({ confidence: 75 });
    assert.equal(priority.level, 'high');
    assert.equal(priority.label, 'High priority');
  });

  it('marks confidence 50-74 as watch priority', () => {
    const priority = getSignalPriority({ confidence: 60 });
    assert.equal(priority.level, 'watch');
    assert.equal(priority.label, 'Opportunity watch');
  });

  it('annotates signals without mutating the original object', () => {
    const signal = { symbol: 'BTCUSDT', confidence: 80 };
    const annotated = annotateSignalPriority(signal);

    assert.equal(signal.priority, undefined);
    assert.equal(annotated.priority, 'high');
    assert.equal(annotated.priorityLabel, 'High priority');
  });

  it('sorts annotated signals by priority before confidence', () => {
    const annotated = annotateSignalPriorities([
      { symbol: 'A', confidence: 74 },
      { symbol: 'B', confidence: 75 },
      { symbol: 'C', confidence: 95 },
    ]);

    assert.deepEqual(annotated.map(s => s.symbol), ['C', 'B', 'A']);
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSummarySubject } from '../src/email/notifier.js';

describe('Email subjects', () => {
  it('makes trading and watch layers explicit in summary email subject', () => {
    const subject = buildSummarySubject([
      { signal: 'BUY', confidence: 80, priority: 'high' },
      { signal: 'SELL', confidence: 60, priority: 'watch' },
      { signal: 'BUY', confidence: 55, priority: 'watch' },
    ], 'tier1');

    assert.match(subject, /交易层 1/);
    assert.match(subject, /观察层 2/);
  });
});

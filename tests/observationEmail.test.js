import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubject, buildHtml, buildSummarySubject, buildSummaryHtml } from '../src/email/notifier.js';
import { prepareObservationDelivery } from '../src/signal/observationDelivery.js';

function signal(overrides = {}) {
  return {
    symbol: 'BTCUSDT', strategy: 'donchian_breakout', signal: 'SELL', confidence: 85,
    suggestedEntry: 100, stopLoss: 105, targetPrice: 90,
    contributing_evidence: [{ strategy: 'donchian_breakout' }, { strategy: 'volume_confirmation' }],
    observation_only: true, observation_candidates: ['A', 'B'],
    observation_trigger_time: '2026-11-03T00:59:59.999Z',
    observation_reference_price: 99.5, observation_reference_time: '2026-11-03T01:01:00.000Z',
    observation_performance: [{
      candidateId: 'A', strategy: 'donchian_breakout', closedTrades: 3,
      openSignals: 2, pendingSignals: 1, invalidSignals: 0, netPnlUSDT: -12.34,
      complete: true, asOf: '2026-11-03T01:00:00Z', startedAt: '2026-11-03T00:00:00Z',
    }, {
      candidateId: 'B', strategy: 'donchian_breakout', closedTrades: 0,
      openSignals: 1, pendingSignals: 0, invalidSignals: 0, netPnlUSDT: 0,
      complete: true, asOf: '2026-11-03T01:00:00Z', startedAt: '2026-11-03T00:00:00Z',
    }],
    observation_history: { start: '2026-09-08', end: '2026-10-31', capitalUSDT: 10000,
      byCandidate: { A: { netPnlUSDT: -71.9772, returnPercent: -0.71977, trades: 103 },
        B: { netPnlUSDT: -51.0673, returnPercent: -0.51067, trades: 60 } } },
    ...overrides,
  };
}

describe('Observation email rendering', () => {
  it('identifies both candidates and original strategy in the subject without duplicate notices', () => {
    assert.match(buildSubject(signal()), /^\[观察A\+B\]\[唐奇安突破\]/);
    assert.doesNotMatch(buildSubject(signal()), /High priority/);
  });

  it('shows the full original strategy cumulative result separately from its A/B subsets', () => {
    const original = signal();
    original.observation_performance.unshift({ candidateId: 'OLD', strategy: 'donchian_breakout',
      closedTrades: 10, openSignals: 4, pendingSignals: 0, invalidSignals: 1,
      netPnlUSDT: 25.67, complete: true, asOf: '2026-11-03T01:00:00Z', startedAt: '2026-11-03T00:00:00Z' });
    for (const html of [buildHtml(original), buildSummaryHtml([original])]) {
      assert.match(html, /原策略整体上线后累计净收益（已结束参考，含A\/B命中）/);
      assert.match(html, /原策略整体 \/ 本策略：累计净收益 \+25\.67 USDT/);
      assert.match(html, /候选A \/ 本策略：累计净收益 -12\.34 USDT/);
      assert.match(html, /候选B \/ 本策略：暂无已结束样本/);
      assert.match(html, /已结束 10 · 未结束 4 · 待复盘 0 · 无效 1/);
      assert.match(html, /原策略整体已包含A\/B样本，整体与分组累计也不可相加/);
    }
  });

  it('separates live closed-reference performance from the historical capital snapshot', () => {
    const html = buildHtml(signal());
    for (const text of ['原始策略：唐奇安突破（donchian_breakout）', '成交量确认（volume_confirmation）',
      '上线观察累计净收益（已结束参考）', '累计净收益 -12.34 USDT', '暂无已结束样本',
      '未结束 2', '待复盘 1', '每个信号固定100 USDT参考', '不是实际账户收益',
      '历史回测固定快照', '初始10000 USDT', '候选A整体：-71.98 USDT', '候选B整体：-51.07 USDT']) {
      assert.ok(html.includes(text), text);
    }
    assert.ok(html.includes('开仓、仓位与退出由你决定，不自动交易'));
    assert.ok(html.includes('邮件发送确认后下一完整分钟开盘价'));
    assert.ok(html.includes('A/B样本有重叠，两组累计不可相加'));
  });

  it('labels timestamped reference quotes and correct SELL stop direction', () => {
    const html = buildHtml(signal());
    assert.match(html, /观察报价（见报价时间）/);
    assert.match(html, /观察报价 \$99\.5000/);
    assert.match(html, /报价时间 .*北京时间/);
    assert.match(html, /触发收盘参考价（非当前报价）/);
    assert.match(html, /止损参考（上涨触及）/);
    assert.doesNotMatch(html, /当前价格|跌破此价建议离场/);
    assert.match(buildHtml(signal({ signal: 'BUY' })), /止损参考（下跌触及）/);
  });

  it('never displays missing, incomplete or unreviewed performance as zero', () => {
    const html = buildHtml(signal({ observation_history: null, observation_performance: [{
      candidateId: 'A', strategy: 'donchian_breakout', complete: false,
      closedTrades: 2, netPnlUSDT: 8, openSignals: 1, pendingSignals: 2, invalidSignals: 0,
    }, { candidateId: 'B', strategy: 'donchian_breakout', complete: true, closedTrades: 1, netPnlUSDT: null }] }));
    assert.match(html, /统计不完整，累计净收益待复盘/);
    assert.match(html, /累计净收益待复盘/);
    assert.doesNotMatch(html, /\+0\.00 USDT|\+8\.00 USDT/);
    assert.match(buildHtml(signal({ observation_performance: [] })), /暂无可用统计/);
  });

  it('reads persisted observation metadata and escapes strategy provenance', () => {
    const original = signal();
    const nested = { ...original, observation_only: undefined, observation_candidates: undefined,
      observation_reference_price: undefined, observation_reference_time: undefined, observation_trigger_time: undefined,
      strategy: '<script>alert(1)</script>', contributingStrategies: ['<img src=x onerror=alert(1)>'],
      raw_features: { observation: original } };
    const html = buildHtml(nested);
    assert.match(buildSubject(nested), /^\[观察A\+B\]/);
    assert.match(html, /&lt;script&gt;/);
    assert.match(html, /&lt;img/);
    assert.doesNotMatch(html, /<script>|<img src=x/);
    assert.match(html, /观察报价 \$99\.5000/);
  });

  it('includes the same source and performance details in summary mail', () => {
    const subject = buildSummarySubject([signal()], 'tier1');
    assert.match(subject, /^\[观察信号汇总\] A 1 \/ B 1/);
    assert.doesNotMatch(subject, /交易层/);
    const html = buildSummaryHtml([signal()], 'tier1');
    assert.match(html, /原始策略：唐奇安突破（donchian_breakout）/);
    assert.match(html, /观察A\+B/);
    assert.match(html, /累计净收益 -12\.34 USDT/);
    assert.match(html, /观察报价 \$99\.5000/);
    assert.doesNotMatch(html, /现价 \$100/);
  });

  it('identifies legacy signal strategy without inventing online cumulative results', () => {
    const html = buildHtml(signal({ observation_only: false }));
    assert.match(html, /原始策略：唐奇安突破（donchian_breakout）/);
    assert.match(html, /该策略上线观察统计尚未建立/);
    assert.doesNotMatch(html, /历史回测固定快照|累计净收益 -12\.34/);
  });

  it('renders the actual orchestration contract and persisted compact metadata', async () => {
    const now = Date.parse('2026-11-03T01:01:00Z');
    const original = signal({ signal_timestamp: '2026-11-03T00:59:59.999Z', raw_features: { currentPrice: 94, sma_50: 100,
      currentVolume: 140, volume_ma_20: 100, atr_14: 2, donchian: { lower: 95 } } });
    const [prepared] = await prepareObservationDelivery([original], {
      now, clock: () => now, priceFetcher: async () => ({ price: '94.7' }),
      performance: { rows: [], available: true }, keepOriginal: false,
    });
    assert.deepEqual(prepared.observation_candidates, ['A', 'B']);
    assert.match(buildHtml(prepared), /已结束 0 · 未结束 0 · 待复盘 0 · 无效 0/);
    assert.match(buildHtml(prepared), /暂无已结束样本/);
    const persisted = { ...prepared, observation_only: undefined, observation_candidates: undefined,
      observation_reference_price: undefined, observation_reference_time: undefined, observation_trigger_time: undefined };
    assert.match(buildSubject(persisted), /^\[观察A\+B\]/);
    assert.match(buildHtml(persisted), /观察报价 \$94\.7000/);
  });

  it('shows legacy strategy live performance without labelling it candidate OLD', () => {
    const original = signal({ observation_only: false, observation_candidates: [],
      observation_performance: [{ candidateId: 'OLD', strategy: 'donchian_breakout',
        closedTrades: 2, openSignals: 1, pendingSignals: 0, invalidSignals: 0,
        netPnlUSDT: 3.45, complete: true }],
      raw_features: { observation: { version: 'ab-observation-v1', candidates: ['OLD'] } } });
    const html = buildHtml(original);
    assert.match(html, /旧规则·本策略上线后累计（已结束参考）/);
    assert.match(html, /旧规则 \/ 本策略：累计净收益 \+3\.45 USDT/);
    assert.doesNotMatch(html, /历史回测固定快照|观察OLD|该策略上线观察统计尚未建立/);
    assert.doesNotMatch(buildSubject(original), /观察/);
  });

  it('uses the timestamped quote for newly tracked OLD mail instead of calling the trigger close current', () => {
    const original = signal({ observation_only: false, observation_candidates: [],
      observation_reference_price: undefined, observation_reference_time: undefined,
      raw_features: { observation: { version: 'ab-observation-v1', candidates: ['OLD'],
        trigger_time: '2026-11-03T00:59:59.999Z', reference_price: 95,
        reference_time: '2026-11-03T01:01:00Z' } } });
    const html = buildHtml(original);
    assert.match(html, /参考报价（见报价时间）/);
    assert.match(html, /\$95\.0000/);
    assert.match(html, /触发收盘参考价（非当前报价）/);
    assert.doesNotMatch(html, /当前价格/);
    const summary = buildSummaryHtml([original]);
    assert.match(summary, /参考报价 \$95\.0000/);
    assert.doesNotMatch(summary, /现价 /);
    original.raw_features.observation.reference_price = null;
    assert.match(buildHtml(original), /参考报价（见报价时间）<\/div>\s*<div[^>]*>N\/A<\/div>/);
    assert.match(buildSummaryHtml([original]), /参考报价 N\/A/);
  });
});

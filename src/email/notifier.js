// Email Notification Module - Gmail SMTP
// 发送交易信号邮件通知

import nodemailer from 'nodemailer';
import { CONFIG } from '../config.js';
import { annotateSignalPriorities } from '../strategies/signalPriority.js';

const { GMAIL } = CONFIG;

let transporter = null;

/**
 * 初始化 Gmail 传输器
 */
function ensureTransporter() {
  if (transporter) return transporter;

  if (!GMAIL.EMAIL || !GMAIL.APP_PASSWORD) {
    console.warn('[Email] Gmail credentials not configured, email notifications disabled');
    return null;
  }

  transporter = nodemailer.createTransport({
    host: GMAIL.HOST,
    port: GMAIL.PORT,
    secure: false,  // TLS
    auth: {
      user: GMAIL.EMAIL,
      pass: GMAIL.APP_PASSWORD,
    },
    pool: true,
    maxConnections: 5,
    rateLimit: true,
    maxMessages: 100,
  });

  return transporter;
}

/**
 * 根据价格大小自动选择合适的小数位数
 * 避免低价币（如STX=$0.19）stopLoss也被截断为2位小数导致看不出差异
 */
function fmtPrice(price) {
  if (price == null) return 'N/A';
  if (price >= 1000) return '$' + price.toFixed(2);       // BTC: $64,156.60
  if (price >= 1)    return '$' + price.toFixed(4);       // LINK: $7.9820
  if (price >= 0.01) return '$' + price.toFixed(5);       // STX: $0.18520
  return '$' + price.toFixed(8);                           // SHIB: $0.00001234
}

/**
 * 将专业术语翻译为普通人可理解的语言
 */
function translateReason(reason) {
  const translations = [
    [/\u591a\u6307\u6807\u5171\u632f\u4e70\u5165\((\d+)\/6\)/g, '$1\u4e2a\u6307\u6807\u770b\u6da8'],
    [/\u591a\u6307\u6807\u5171\u632f\u5356\u51fa\((\d+)\/6\)/g, '$1\u4e2a\u6307\u6807\u770b\u8dcc'],
    [/MACD\u91d1\u53c9/g, 'MACD \u770b\u6da8'],
    [/MACD\u6b7b\u53c9/g, 'MACD \u770b\u8dcc'],
    [/EMA\u591a\u5934/g, 'EMA \u770b\u6da8'],
    [/EMA\u7a7a\u5934/g, 'EMA \u770b\u8dcc'],
    [/\u4ef7\u683c>SMA50/g, '\u4ef7\u683c\u9ad8\u4e8e SMA50'],
    [/\u4ef7\u683c<SMA50/g, '\u4ef7\u683c\u4f4e\u4e8e SMA50'],
    [/RSI\u504f\u5f3a/g, 'RSI \u504f\u5f3a'],
    [/RSI\u504f\u5f31/g, 'RSI \u504f\u5f31'],
    [/\u653e\u91cf\u4e0a\u6da8/g, '\u6210\u4ea4\u91cf\u653e\u5927\u4e14\u4e0a\u6da8'],
    [/\u653e\u91cf\u4e0b\u8dcc/g, '\u6210\u4ea4\u91cf\u653e\u5927\u4e14\u4e0b\u8dcc'],
    [/BB\u504f\u4e0a\u8f68/g, '\u4ef7\u683c\u63a5\u8fd1\u9ad8\u4f4d'],
    [/BB\u504f\u4e0b\u8f68/g, '\u4ef7\u683c\u63a5\u8fd1\u4f4e\u4f4d'],
  ];

  return translations.reduce(
    (current, [pattern, replacement]) => current.replace(pattern, replacement),
    String(reason || '')
  );
}

/**
 * 将指标key翻译成中文
 */
function translateIndicatorKey(key) {
  const map = {
    'buy_votes': '看涨因素',
    'sell_votes': '看跌因素',
    'rsi_14': '强弱指标',
    'macd_histogram': '趋势动量',
    'bb_percentB': '价格位势',
  };
  return map[key] || key;
}

/**
 * 格式化交易对名称 (BTCUSDT -> BTC/USDT)
 */
function formatPair(symbol) {
  // 常见 quote currencies
  const quotes = ['USDT', 'BUSD', 'USD', 'BTC', 'ETH', 'BNB'];
  for (const q of quotes) {
    if (symbol.endsWith(q)) {
      return symbol.slice(0, -q.length) + '/' + q;
    }
  }
  return symbol;
}

const STRATEGY_NAMES = {
  rsi_reversal: 'RSI反转', macd_cross: 'MACD交叉',
  bollinger_mean_reversion: '布林均值回归', ema_crossover: 'EMA交叉',
  multi_indicator_resonance: '多指标共振', donchian_breakout: '唐奇安突破',
  atr_volatility: 'ATR波动', volume_confirmation: '成交量确认',
  resonance_SELL: '做空共振', resonance_BUY: '做多共振',
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function observationField(signal, key) {
  const metadata = signal?.raw_features?.observation;
  const persistedKey = {
    observation_candidates: 'candidates', observation_reference_price: 'reference_price',
    observation_reference_time: 'reference_time', observation_trigger_time: 'trigger_time',
  }[key];
  return signal?.[key] ?? metadata?.[key] ?? metadata?.[persistedKey];
}

function isObservation(signal) {
  const flag = observationField(signal, 'observation_only');
  return flag === undefined
    ? Boolean(signal?.raw_features?.observation?.version && observationCandidates(signal).length)
    : flag === true;
}

function hasReferenceMetadata(signal) {
  return isObservation(signal) || Boolean(signal?.raw_features?.observation?.version);
}

function observationCandidates(signal) {
  const candidates = observationField(signal, 'observation_candidates');
  return [...new Set(Array.isArray(candidates) ? candidates.filter(id => ['A', 'B'].includes(id)) : [])];
}

function strategyLabel(strategy) {
  return `${STRATEGY_NAMES[strategy] || '未知策略'}（${strategy || '未记录'}）`;
}

function numeric(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value))
    ? null : Number(value);
}

function fmtNet(value) {
  const net = numeric(value);
  return net === null ? '待复盘' : `${net >= 0 ? '+' : ''}${net.toFixed(2)} USDT`;
}

function fmtTime(value) {
  const timestamp = new Date(value);
  return value && !Number.isNaN(timestamp.getTime())
    ? `${timestamp.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })} 北京时间` : '未记录';
}

function referencePrice(signal) {
  return numeric(observationField(signal, 'observation_reference_price'));
}

function buildStrategyDetails(signal) {
  const contributors = [...new Set([
    ...(Array.isArray(signal.contributingStrategies) ? signal.contributingStrategies : []),
    ...(Array.isArray(signal.contributing_evidence) ? signal.contributing_evidence.map(item => item.strategy) : []),
  ].filter(Boolean))];
  const source = `<div>原始策略：${escapeHtml(strategyLabel(signal.strategy))}</div>`
    + (contributors.length ? `<div>参与策略：${contributors.map(id => escapeHtml(strategyLabel(id))).join('、')}</div>` : '');
  const candidates = observationCandidates(signal);
  const performance = Array.isArray(signal.observation_performance) ? signal.observation_performance : [];
  function performanceRow(candidate, label = `候选${candidate} / 本策略`) {
    const stats = performance.find(item => item.candidateId === candidate && item.strategy === signal.strategy);
    if (!stats) return `<div>${label}：待复盘，暂无可用统计。</div>`;
    const closed = numeric(stats.closedTrades ?? stats.closed);
    const value = stats.complete !== true ? '统计不完整，累计净收益待复盘'
      : closed === 0 ? '暂无已结束样本'
        : numeric(stats.netPnlUSDT) === null ? '累计净收益待复盘'
          : `累计净收益 ${fmtNet(stats.netPnlUSDT)}`;
    return `<div>${label}：${escapeHtml(value)}</div>
      <div style="color:#999;">已结束 ${closed ?? '未知'} · 未结束 ${numeric(stats.openSignals ?? stats.open) ?? '未知'} · 待复盘 ${numeric(stats.pendingSignals ?? stats.pending) ?? '未知'} · 无效 ${numeric(stats.invalidSignals ?? stats.invalid) ?? '未知'}</div>
      <div style="color:#999;">观察起点 ${escapeHtml(fmtTime(stats.startedAt ?? stats.firstObservedAt))}；统计截至 ${escapeHtml(fmtTime(stats.asOf))}</div>`;
  }
  const costNote = '<div style="color:#999;">每个信号固定100 USDT参考，以邮件发送确认后下一完整分钟开盘价建立参考，扣除双边0.14%手续费与滑点及历史资金费；未结束不计为零，也不混入已结束累计。不是实际账户收益。</div>';
  const quoteDetails = `<div>触发收盘 ${escapeHtml(fmtTime(observationField(signal, 'observation_trigger_time')))}</div>
    <div>参考报价 ${referencePrice(signal) === null ? '未取得' : fmtPrice(referencePrice(signal))}；报价时间 ${escapeHtml(fmtTime(observationField(signal, 'observation_reference_time')))}</div>`;
  if (!isObservation(signal)) {
    const old = performance.find(item => item.candidateId === 'OLD' && item.strategy === signal.strategy);
    return `<div style="font-size:12px;color:#aaa;line-height:1.7;margin-bottom:12px;">${source}${old
      ? `${quoteDetails}<div style="margin-top:8px;font-weight:bold;">旧规则·本策略上线后累计（已结束参考）</div>${performanceRow('OLD', '旧规则 / 本策略')}${costNote}`
      : '<div>该策略上线观察统计尚未建立</div>'}</div>`;
  }
  const rows = candidates.map(candidate => performanceRow(candidate)).join('');
  const history = signal.observation_history;
  const historicalRows = history?.byCandidate ? candidates.map(candidate => {
    const snapshot = history.byCandidate[candidate];
    if (!snapshot) return '';
    const rate = numeric(snapshot.returnPercent);
    return `<div>候选${candidate}整体：${escapeHtml(fmtNet(snapshot.netPnlUSDT))}${rate === null ? '' : `（${rate.toFixed(2)}%）`}，${numeric(snapshot.trades) ?? '未知'}笔。</div>`;
  }).join('') : '';
  return `<div style="background:#15243e;border:1px solid #7aa2ff55;border-radius:8px;padding:12px;margin-bottom:12px;font-size:12px;line-height:1.7;color:#ccc;">
    <div style="color:#a7c4ff;font-weight:bold;">观察候选 ${candidates.map(escapeHtml).join(' + ')} · 仅信号提醒，开仓、仓位与退出由你决定，不自动交易</div>
    ${source}
    <div>触发收盘 ${escapeHtml(fmtTime(observationField(signal, 'observation_trigger_time')))}</div>
    <div>观察报价 ${referencePrice(signal) === null ? '未取得' : fmtPrice(referencePrice(signal))}；报价时间 ${escapeHtml(fmtTime(observationField(signal, 'observation_reference_time')))}</div>
    <div style="margin-top:8px;font-weight:bold;color:#a7c4ff;">上线观察累计净收益（已结束参考）</div>
    ${rows}
    <div style="color:#999;">A/B样本有重叠，两组累计不可相加。</div>
    ${costNote}
    ${historicalRows ? `<div style="margin-top:8px;color:#999;">历史回测固定快照（${escapeHtml(history.start)} 至 ${escapeHtml(history.end)}；初始${escapeHtml(history.capitalUSDT)} USDT、18币分配；与上线观察分别统计）</div>${historicalRows}` : ''}
  </div>`;
}

export function formatSignalScore(signal) {
  const score = Number(signal?.score);
  if (Number.isFinite(score)) return score.toFixed(1);
  const confidence = Number(signal?.confidence);
  if (Number.isFinite(confidence)) return String(confidence);
  return '--';
}


/**
 * 生成邮件主题
 */
export function buildSubject(signal) {
  const pair = formatPair(signal.symbol);
  const icon = signal.signal === 'BUY' ? '🟢' : '🔴';
  const direction = signal.signal === 'BUY' ? '看涨提醒' : '看跌提醒';
  const priority = signal.priorityLabel ? ` ${signal.priorityLabel}` : '';
  if (isObservation(signal)) {
    return `[观察${observationCandidates(signal).join('+')}][${STRATEGY_NAMES[signal.strategy] || '未知策略'}] [${pair}] ${icon} ${direction} - 信号评分${formatSignalScore(signal)}`;
  }
  return `[${pair}]${priority} ${icon} ${direction} - 信号评分${formatSignalScore(signal)}`;
}

/**
 * 生成邮件正文 HTML
 */
export function buildHtml(signal) {
  const pair = formatPair(signal.symbol);
  const signalColor = signal.signal === 'BUY' ? '#16c784' : '#ea3943';
  const signalLabel = signal.signal === 'BUY' ? '看涨提醒' : '看跌提醒';
  const simpleDescription = signal.signal === 'BUY'
    ? '根据多个技术指标分析，该币种短期可能上涨，值得关注。'
    : '根据多个技术指标分析，该币种短期可能下跌，注意风险。';

  const translatedReason = translateReason(signal.reason || '');
  const signalScore = formatSignalScore(signal);
  const observation = isObservation(signal);
  const hasReference = hasReferenceMetadata(signal);
  const displayedPrice = hasReference ? referencePrice(signal) : signal.suggestedEntry;

  const indicatorRows = Object.entries(signal.indicators || {})
    .map(([k, v]) => `<tr><td style="padding:4px 12px;color:#999;">${translateIndicatorKey(k)}</td><td style="padding:4px 12px;font-weight:bold;">${v}</td></tr>`)
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background:#16213e;border-radius:12px;overflow:hidden;">
    <!-- Header -->
    <div style="padding:24px;background:linear-gradient(135deg,#0f3460,#16213e);border-bottom:2px solid ${signalColor};">
      <h1 style="margin:0;font-size:20px;color:${signalColor};">${signalLabel}</h1>
      <h2 style="margin:8px 0 0;font-size:28px;color:#fff;">${pair}</h2>
      <p style="margin:4px 0 0;color:#999;font-size:14px;">${simpleDescription}</p>
    </div>

    <!-- Price & Signal -->
    <div style="padding:20px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div style="color:#999;font-size:12px;">${hasReference ? (observation ? '观察报价（见报价时间）' : '参考报价（见报价时间）') : '当前价格'}</div>
          <div style="font-size:24px;font-weight:bold;color:#fff;">${fmtPrice(displayedPrice)}</div>
        </div>
        <div style="text-align:right;">
          <div style="color:#999;font-size:12px;">信号评分</div>
          <div style="font-size:24px;font-weight:bold;color:${signalColor};">${signalScore}</div>
        </div>
      </div>

      ${buildStrategyDetails(signal)}

      <!-- Entry/StopLoss/Target -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">${hasReference ? '触发收盘参考价（非当前报价）' : '参考入场价'}</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#fff;">${fmtPrice(signal.suggestedEntry)}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">止损参考（${signal.signal === 'SELL' ? '上涨触及' : '下跌触及'}）</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#ea3943;">${fmtPrice(signal.stopLoss)}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">目标价（可考虑止盈的价位）</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#16c784;">${fmtPrice(signal.targetPrice)}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">盈亏比</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#ffd700;">${typeof signal.riskRewardRatio === 'number' ? '1:' + signal.riskRewardRatio : (signal.riskRewardRatio || 'N/A')}</td>
        </tr>
      </table>

      <!-- Reason -->
      <div style="background:#1a1a2e;border-radius:8px;padding:12px;margin-bottom:16px;">
        <div style="color:#999;font-size:12px;margin-bottom:6px;">触发原因</div>
        <div style="color:#e0e0e0;font-size:14px;line-height:1.6;">${translatedReason}</div>
      </div>

      <!-- Indicators -->
      <div style="background:#1a1a2e;border-radius:8px;padding:12px;">
        <div style="color:#999;font-size:12px;margin-bottom:6px;">参考指标（点击可查看详情）</div>
        <table style="width:100%;border-collapse:collapse;">
          ${indicatorRows}
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px;border-top:1px solid #2a2a4a;">
      <div style="background:#1a0a0a;border:1px solid #ea394355;border-radius:8px;padding:12px;margin-bottom:12px;">
        <div style="color:#ea3943;font-size:12px;font-weight:bold;margin-bottom:4px;">风险提示</div>
        <div style="color:#ccc;font-size:11px;line-height:1.5;">
          以上内容仅为技术分析参考，不构成投资建议。加密货币价格波动大，任何交易都有亏损风险，请根据自身情况谨慎决策，切勿投入超过承受能力的资金。
        </div>
      </div>
      <p style="margin:0;color:#666;font-size:11px;text-align:center;">
        Crypto Alerts 信号提醒 | 仅供参考 | ${new Date().toISOString()}
      </p>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 发送交易信号邮件（单条，保留接口兼容）
 * @param {object} signal - 信号对象
 * @returns {boolean} 是否发送成功
 */
export async function sendSignalEmail(signal) {
  const tp = ensureTransporter();
  if (!tp) {
    console.log('[Email] Skipped (not configured):', signal.symbol, signal.strategy);
    return false;
  }

  try {
    const subject = buildSubject(signal);
    const html = buildHtml(signal);

    const info = await tp.sendMail({
      from: `"Crypto Alerts" <${GMAIL.EMAIL}>`,
      to: CONFIG.NOTIFICATION_EMAIL || GMAIL.EMAIL,
      subject,
      html,
    });

    console.log('[Email] Sent:', subject, '- to:', CONFIG.NOTIFICATION_EMAIL || GMAIL.EMAIL);
    return true;
  } catch (err) {
    console.error('[Email] Send failed:', err.message);
    return false;
  }
}

/**
 * 发送汇总邮件 - 一次检测的所有新信号合并为一封邮件
 * 按信号强度排序，重点信号置顶
 * @param {Array} signals - 新信号数组
 * @param {string} tierKey - 档位 key
 * @returns {boolean} 是否发送成功
 */
export function buildSummarySubject(signals, tierKey = 'all') {
  const annotated = annotateSignalPriorities(signals || []);
  const buyCount = annotated.filter(s => s.signal === 'BUY').length;
  const sellCount = annotated.filter(s => s.signal === 'SELL').length;
  const tradingLayerCount = annotated.filter(s => s.priority === 'high').length;
  const watchLayerCount = annotated.filter(s => s.priority === 'watch').length;
  const tierNames = { tier1: '\u4e3b\u6d41', tier2: '\u70ed\u95e8', tier3: '\u65b0\u9510', all: '\u5168\u90e8' };
  const tierLabel = tierNames[tierKey] || '\u5168\u90e8';

  const observations = annotated.filter(isObservation);
  if (observations.length) {
    const count = candidate => observations.filter(signal => observationCandidates(signal).includes(candidate)).length;
    return `[观察信号汇总] A ${count('A')} / B ${count('B')} · ${observations.length}条观察提醒 - ${tierLabel}币种`;
  }

  return '[\u4fe1\u53f7\u6c47\u603b] \u4ea4\u6613\u5c42 ' + tradingLayerCount + ' / \u89c2\u5bdf\u5c42 ' + watchLayerCount + ' | \u770b\u6da8 ' + buyCount + ' / \u770b\u8dcc ' + sellCount + ' - ' + tierLabel + '\u5e01\u79cd';
}

export function buildSummaryHtml(signals, tierKey = 'all') {
  // 按置信度降序排列，最强的排最前面
  const sorted = annotateSignalPriorities(signals);

  const buySignals = sorted.filter(s => s.signal === 'BUY');
  const sellSignals = sorted.filter(s => s.signal === 'SELL');
  const highPrioritySignals = sorted.filter(s => s.priority === 'high' && !isObservation(s));
  const watchSignals = sorted.filter(s => s.priority === 'watch');

  const tierNames = { tier1: '主流', tier2: '热门', tier3: '新锐', all: '全部' };
  const tierLabel = tierNames[tierKey] || '全部';

  // 构建每条信号的卡片
  function buildSignalCard(signal) {
    const color = signal.signal === 'BUY' ? '#16c784' : '#ea3943';
    const label = signal.signal === 'BUY' ? '看涨' : '看跌';
    const reason = translateReason(signal.reason || '');
    const signalScore = formatSignalScore(signal);
    const priorityColor = signal.priority === 'high' ? '#ffd700' : '#7aa2ff';
    const priorityLabel = isObservation(signal) ? `观察${observationCandidates(signal).join('+')}` : signal.priorityLabel || 'Opportunity watch';

    return `
    <div style="background:#1a1a2e;border-radius:8px;padding:14px;margin-bottom:10px;border-left:3px solid ${color};">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <span style="color:${color};font-weight:bold;font-size:16px;">${formatPair(signal.symbol)}</span>
          <span style="background:${color}22;color:${color};padding:2px 8px;border-radius:4px;font-size:12px;margin-left:8px;">${label}</span>
          <span style="background:${priorityColor}22;color:${priorityColor};padding:2px 8px;border-radius:4px;font-size:12px;margin-left:6px;">${priorityLabel}</span>
        </div>
        <span style="color:${color};font-weight:bold;font-size:18px;">${signalScore}</span>
      </div>
      ${buildStrategyDetails(signal)}
      <div style="color:#ccc;font-size:13px;margin-bottom:6px;">${reason}</div>
      <div style="display:flex;gap:16px;font-size:12px;color:#999;">
        <span>${hasReferenceMetadata(signal) ? (isObservation(signal) ? '观察报价 ' : '参考报价 ') + fmtPrice(referencePrice(signal)) : '现价 ' + fmtPrice(signal.suggestedEntry)}</span>
        <span style="color:#ea3943;">止损 ${fmtPrice(signal.stopLoss)}</span>
        <span style="color:#16c784;">目标 ${fmtPrice(signal.targetPrice)}</span>
      </div>
    </div>`;
  }

  const allCards = sorted.map(buildSignalCard).join('\n');

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#1a1a2e;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background:#16213e;border-radius:12px;overflow:hidden;">
    <!-- Header -->
    <div style="padding:20px;background:linear-gradient(135deg,#0f3460,#16213e);">
      <h1 style="margin:0;font-size:18px;color:#e0e0e0;">信号汇总</h1>
      <p style="margin:6px 0 0;color:#999;font-size:13px;">
        ${tierLabel}币种检测完成 · ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}
      </p>
      <div style="display:flex;gap:16px;margin-top:12px;">
        <div style="background:#16c78422;border-radius:6px;padding:6px 14px;">
          <span style="color:#16c784;font-weight:bold;font-size:20px;">${buySignals.length}</span>
          <span style="color:#16c784;font-size:12px;margin-left:4px;">看涨</span>
        </div>
        <div style="background:#ea394322;border-radius:6px;padding:6px 14px;">
          <span style="color:#ea3943;font-weight:bold;font-size:20px;">${sellSignals.length}</span>
          <span style="color:#ea3943;font-size:12px;margin-left:4px;">看跌</span>
        </div>
        <div style="background:#ffd70022;border-radius:6px;padding:6px 14px;">
          <span style="color:#ffd700;font-weight:bold;font-size:20px;">${highPrioritySignals.length}</span>
          <span style="color:#ffd700;font-size:12px;margin-left:4px;">High</span>
        </div>
      </div>
    </div>

    <!-- Signals -->
    <div style="padding:16px;">
      ${allCards}
    </div>

    <!-- Footer -->
    <div style="padding:14px;border-top:1px solid #2a2a4a;">
      <div style="background:#1a0a0a;border:1px solid #ea394355;border-radius:8px;padding:10px;margin-bottom:10px;">
        <div style="color:#ea3943;font-size:11px;font-weight:bold;margin-bottom:3px;">风险提示</div>
        <div style="color:#aaa;font-size:11px;line-height:1.4;">
          以上内容仅为技术分析参考，不构成投资建议。请根据自身情况谨慎决策。
        </div>
      </div>
      <p style="margin:0;color:#555;font-size:10px;text-align:center;">Crypto Alerts | 仅供参考</p>
    </div>
  </div>
</body>
</html>`;

  return html;
}

export async function sendSummaryEmail(signals, tierKey = 'all') {
  const tp = ensureTransporter();
  if (!tp) return false;
  const sorted = annotateSignalPriorities(signals);
  const buySignals = sorted.filter(signal => signal.signal === 'BUY');
  const sellSignals = sorted.filter(signal => signal.signal === 'SELL');
  const subject = buildSummarySubject(sorted, tierKey);
  const html = buildSummaryHtml(sorted, tierKey);

  try {
    await tp.sendMail({
      from: `"Crypto Alerts" <${GMAIL.EMAIL}>`,
      to: CONFIG.NOTIFICATION_EMAIL || GMAIL.EMAIL,
      subject,
      html,
    });
    console.log(`[Email] Summary sent: ${signals.length} signals (${buySignals.length} buy / ${sellSignals.length} sell)`);
    return true;
  } catch (err) {
    console.error('[Email] Summary send failed:', err.message);
    return false;
  }
}

/**
 * 发送启动通知邮件
 */
export async function sendStartupEmail(symbols) {
  const tp = ensureTransporter();
  if (!tp) return false;

  try {
    const pairList = symbols.map(s => formatPair(s)).join(', ');
    const subject = '[Crypto Alerts] 服务已启动';
    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#1a1a2e;color:#e0e0e0;font-family:sans-serif;">
  <div style="max-width:500px;margin:20px auto;background:#16213e;border-radius:12px;padding:24px;">
    <h2 style="color:#16c784;margin:0 0 12px;">Crypto Alerts 服务已启动</h2>
    <p style="color:#999;font-size:14px;">正在监控以下交易对：</p>
    <p style="color:#fff;font-size:16px;font-weight:bold;">${pairList}</p>
    <p style="color:#666;font-size:12px;margin-top:20px;">启动时间: ${new Date().toISOString()}</p>
  </div>
</body>
</html>`;

    await tp.sendMail({
      from: `"Crypto Alerts" <${GMAIL.EMAIL}>`,
      to: CONFIG.NOTIFICATION_EMAIL || GMAIL.EMAIL,
      subject,
      html,
    });

    console.log('[Email] Startup notification sent');
    return true;
  } catch (err) {
    console.warn('[Email] Startup notification failed:', err.message);
    return false;
  }
}

/**
 * 验证邮件配置
 */
export async function verifyEmailConfig() {
  const tp = ensureTransporter();
  if (!tp) return false;

  try {
    await tp.verify();
    console.log('[Email] Gmail SMTP verified OK');
    return true;
  } catch (err) {
    console.error('[Email] Gmail SMTP verification failed:', err.message);
    return false;
  }
}

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
function buildSubject(signal) {
  const pair = formatPair(signal.symbol);
  const icon = signal.signal === 'BUY' ? '🟢' : '🔴';
  const direction = signal.signal === 'BUY' ? '看涨提醒' : '看跌提醒';
  const priority = signal.priorityLabel ? ` ${signal.priorityLabel}` : '';
  return `[${pair}]${priority} ${icon} ${direction} - 信号评分${formatSignalScore(signal)}`;
}

/**
 * 生成邮件正文 HTML
 */
function buildHtml(signal) {
  const pair = formatPair(signal.symbol);
  const signalColor = signal.signal === 'BUY' ? '#16c784' : '#ea3943';
  const signalLabel = signal.signal === 'BUY' ? '看涨提醒' : '看跌提醒';
  const simpleDescription = signal.signal === 'BUY'
    ? '根据多个技术指标分析，该币种短期可能上涨，值得关注。'
    : '根据多个技术指标分析，该币种短期可能下跌，注意风险。';

  const translatedReason = translateReason(signal.reason || '');
  const signalScore = formatSignalScore(signal);

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
          <div style="color:#999;font-size:12px;">当前价格</div>
          <div style="font-size:24px;font-weight:bold;color:#fff;">${fmtPrice(signal.suggestedEntry)}</div>
        </div>
        <div style="text-align:right;">
          <div style="color:#999;font-size:12px;">信号评分</div>
          <div style="font-size:24px;font-weight:bold;color:${signalColor};">${signalScore}</div>
        </div>
      </div>

      <!-- Entry/StopLoss/Target -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">参考入场价</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#fff;">${fmtPrice(signal.suggestedEntry)}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">止损位（跌破此价建议离场）</td>
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

  return '[\u4fe1\u53f7\u6c47\u603b] \u4ea4\u6613\u5c42 ' + tradingLayerCount + ' / \u89c2\u5bdf\u5c42 ' + watchLayerCount + ' | \u770b\u6da8 ' + buyCount + ' / \u770b\u8dcc ' + sellCount + ' - ' + tierLabel + '\u5e01\u79cd';
}

export async function sendSummaryEmail(signals, tierKey = 'all') {
  const tp = ensureTransporter();
  if (!tp) return false;

  // 按置信度降序排列，最强的排最前面
  const sorted = annotateSignalPriorities(signals);

  const buySignals = sorted.filter(s => s.signal === 'BUY');
  const sellSignals = sorted.filter(s => s.signal === 'SELL');
  const highPrioritySignals = sorted.filter(s => s.priority === 'high');
  const watchSignals = sorted.filter(s => s.priority === 'watch');

  const tierNames = { tier1: '主流', tier2: '热门', tier3: '新锐', all: '全部' };
  const tierLabel = tierNames[tierKey] || '全部';

  // 邮件主题
  const subject = buildSummarySubject(sorted, tierKey);

  // 构建每条信号的卡片
  function buildSignalCard(signal) {
    const color = signal.signal === 'BUY' ? '#16c784' : '#ea3943';
    const label = signal.signal === 'BUY' ? '看涨' : '看跌';
    const reason = translateReason(signal.reason || '');
    const signalScore = formatSignalScore(signal);
    const priorityColor = signal.priority === 'high' ? '#ffd700' : '#7aa2ff';
    const priorityLabel = signal.priorityLabel || 'Opportunity watch';

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
      <div style="color:#ccc;font-size:13px;margin-bottom:6px;">${reason}</div>
      <div style="display:flex;gap:16px;font-size:12px;color:#999;">
        <span>现价 ${fmtPrice(signal.suggestedEntry)}</span>
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

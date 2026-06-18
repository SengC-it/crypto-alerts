// Email Notification Module - Gmail SMTP
// 发送交易信号邮件通知

import nodemailer from 'nodemailer';
import { CONFIG } from '../config.js';

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
  return reason
    .replace(/多指标共振买入\((\d+)\/6\)/g, '$1个指标看涨')
    .replace(/多指标共振卖出\((\d+)\/6\)/g, '$1个指标看跌')
    .replace(/MACD金叉/g, '短期趋势向上')
    .replace(/MACD死叉/g, '短期趋势向下')
    .replace(/EMA多头/g, '均线向上排列')
    .replace(/EMA空头/g, '均线向下排列')
    .replace(/价格>SMA50/g, '价格高于中期均线')
    .replace(/价格<SMA50/g, '价格低于中期均线')
    .replace(/RSI偏强/g, '短期偏强')
    .replace(/RSI偏弱/g, '短期偏弱')
    .replace(/放量上涨/g, '成交量放大且上涨')
    .replace(/放量下跌/g, '成交量放大且下跌')
    .replace(/BB偏上轨/g, '价格接近高位')
    .replace(/BB偏下轨/g, '价格接近低位');
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

/**
 * 生成邮件主题
 */
function buildSubject(signal) {
  const pair = formatPair(signal.symbol);
  const icon = signal.signal === 'BUY' ? '🟢' : '🔴';
  const direction = signal.signal === 'BUY' ? '看涨提醒' : '看跌提醒';
  return `[${pair}] ${icon} ${direction} - 信号强度${signal.confidence}%`;
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
          <div style="color:#999;font-size:12px;">信号强度</div>
          <div style="font-size:24px;font-weight:bold;color:${signalColor};">${signal.confidence}%</div>
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
 * 发送交易信号邮件
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

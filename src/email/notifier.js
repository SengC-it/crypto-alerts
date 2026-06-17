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
  const direction = signal.signal === 'BUY' ? '建议关注' : '注意风险';
  return `[${pair}] ${icon} ${signal.name} - ${direction}`;
}

/**
 * 生成邮件正文 HTML
 */
function buildHtml(signal) {
  const pair = formatPair(signal.symbol);
  const signalColor = signal.signal === 'BUY' ? '#16c784' : '#ea3943';
  const signalLabel = signal.signal === 'BUY' ? '买入信号' : '卖出信号';

  const indicatorRows = Object.entries(signal.indicators || {})
    .map(([k, v]) => `<tr><td style="padding:4px 12px;color:#999;">${k}</td><td style="padding:4px 12px;font-weight:bold;">${v}</td></tr>`)
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
      <p style="margin:4px 0 0;color:#999;font-size:14px;">${signal.name}</p>
    </div>

    <!-- Price & Signal -->
    <div style="padding:20px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:16px;">
        <div>
          <div style="color:#999;font-size:12px;">当前价格</div>
          <div style="font-size:24px;font-weight:bold;color:#fff;">$${signal.suggestedEntry?.toFixed(2) || 'N/A'}</div>
        </div>
        <div style="text-align:right;">
          <div style="color:#999;font-size:12px;">置信度</div>
          <div style="font-size:24px;font-weight:bold;color:${signalColor};">${signal.confidence}%</div>
        </div>
      </div>

      <!-- Entry/StopLoss/Target -->
      <table style="width:100%;border-collapse:collapse;margin-bottom:16px;">
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">建议入场</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#fff;">$${signal.suggestedEntry?.toFixed(2) || 'N/A'}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">止损位</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#ea3943;">$${signal.stopLoss?.toFixed(2) || 'N/A'}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">目标价</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#16c784;">$${signal.targetPrice?.toFixed(2) || 'N/A'}</td>
        </tr>
        <tr style="background:#1a1a2e;">
          <td style="padding:10px 12px;color:#999;">风险收益比</td>
          <td style="padding:10px 12px;text-align:right;font-weight:bold;color:#ffd700;">${signal.riskRewardRatio || 'N/A'}</td>
        </tr>
      </table>

      <!-- Reason -->
      <div style="background:#1a1a2e;border-radius:8px;padding:12px;margin-bottom:16px;">
        <div style="color:#999;font-size:12px;margin-bottom:6px;">策略逻辑</div>
        <div style="color:#e0e0e0;font-size:14px;line-height:1.6;">${signal.reason || 'N/A'}</div>
      </div>

      <!-- Indicators -->
      <div style="background:#1a1a2e;border-radius:8px;padding:12px;">
        <div style="color:#999;font-size:12px;margin-bottom:6px;">指标数值</div>
        <table style="width:100%;border-collapse:collapse;">
          ${indicatorRows}
        </table>
      </div>
    </div>

    <!-- Footer -->
    <div style="padding:16px;border-top:1px solid #2a2a4a;text-align:center;">
      <p style="margin:0;color:#666;font-size:11px;">
        本工具仅提供信号提醒，不自动执行交易。过往表现不代表未来收益，交易需自行承担风险。
      </p>
      <p style="margin:4px 0 0;color:#444;font-size:10px;">
        Crypto Alerts | ${new Date().toISOString()}
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
      to: GMAIL.EMAIL,
      subject,
      html,
    });

    console.log('[Email] Sent:', subject, '- messageId:', info.messageId);
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
      to: GMAIL.EMAIL,
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

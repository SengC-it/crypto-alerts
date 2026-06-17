---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: 'a3bf1b35-2ec8-4b04-8b37-7ff6e247615b'
  PropagateID: 'a3bf1b35-2ec8-4b04-8b37-7ff6e247615b'
  ReservedCode1: '23bd5486-f7fe-4b79-b800-320122d0c091'
  ReservedCode2: '23bd5486-f7fe-4b79-b800-320122d0c091'
---

# Crypto Alerts - Trading Signal Notifier

加密货币合约交易信号提醒系统，基于 Binance 合约 API，支持 8 种技术分析策略，通过 Gmail 邮件发送交易信号。

## 功能

- 实时市场监控（本地模式 WebSocket / 云端模式 Cron 定时）
- 8 种可配置交易策略：RSI 反转、MACD 交叉、布林带均值回归、EMA 双均线交叉、多指标共振、唐奇安通道突破、ATR 波动率、成交量确认
- Gmail 邮件通知（精美 HTML 模板，含入场价/止损/目标价/置信度）
- 信号去重（同一信号 24h 内不重复发送）
- Supabase 信号持久化存储
- 置信度评分（0-100）
- Vercel Serverless 部署 + Cron 定时检测
- Web 仪表盘

## 项目结构

```
crypto-alerts/
├── api/                    # Vercel Serverless API
│   ├── check.js            # Cron 触发的信号检测端点
│   ├── health.js           # 健康检查
│   ├── signals.js          # 获取信号记录
│   └── lib/
│       └── checker.js      # 核心检测逻辑（Serverless 版）
├── src/
│   ├── index.js            # 本地运行入口（WebSocket 模式）
│   ├── config.js           # 环境变量加载
│   ├── indicators/         # 技术指标库
│   ├── strategies/         # 8 种交易策略
│   ├── websocket/          # Binance WS + REST 客户端
│   ├── db/                 # 信号存储（内存 + Supabase）
│   └── email/              # Gmail 邮件通知
├── public/
│   └── index.html          # Web 仪表盘
├── tests/                  # 测试文件
├── supabase/
│   └── schema.sql          # Supabase 建表 SQL
├── vercel.json             # Vercel 部署配置
└── package.json
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

复制 `.env.example` 为 `.env`，填写以下配置：

| 变量 | 说明 | 必填 |
|------|------|------|
| `GMAIL_EMAIL` | Gmail 邮箱地址 | 是 |
| `GMAIL_APP_PASSWORD` | Gmail 应用专用密码（16位） | 是 |
| `SUPABASE_URL` | Supabase 项目 URL | 否（不用则内存存储） |
| `SUPABASE_KEY` | Supabase 匿名密钥 | 否 |
| `MONITOR_PAIRS` | 监控交易对（逗号分隔） | 否（默认8个主流币） |
| `SIGNAL_COOLDOWN_MINUTES` | 信号冷却时间（分钟） | 否（默认240） |
| `CRON_SECRET` | API 访问密钥（保护 Cron 端点） | 否 |

### 3. 本地运行

```bash
# WebSocket 模式（实时监控）
npm start

# 开发模式（自动重启）
npm run dev
```

### 4. 运行测试

```bash
npm test
```

## 部署到 Vercel + Supabase

### Supabase 配置

1. 创建 [Supabase](https://supabase.com) 项目
2. 进入 SQL Editor，执行 `supabase/schema.sql` 中的建表脚本
3. 在项目设置中获取 URL 和 anon key

### Vercel 部署

1. 将代码推送到 GitHub
2. 在 [Vercel](https://vercel.com) 导入 GitHub 仓库
3. 配置环境变量（同上 `.env` 中的变量）
4. 部署完成后，Vercel Cron 将每小时自动调用 `/api/check` 执行检测

### 本地测试 Serverless API

```bash
npx vercel dev
# 访问 http://localhost:3000
```

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/api/health` | GET | 健康检查 |
| `/api/check` | GET | 执行信号检测（Cron 每小时调用） |
| `/api/signals?symbol=BTCUSDT&limit=10` | GET | 获取信号记录 |

## 策略说明

| 策略 | 说明 | 信号触发条件 |
|------|------|-------------|
| RSI 反转 | 经典超买超卖 | RSI < 30 买入 / RSI > 70 卖出 |
| MACD 交叉 | 金叉死叉 | MACD 线上穿/下穿信号线 |
| 布林带均值回归 | 价格触轨回归 | 价格触及上下轨 |
| EMA 双均线交叉 | 9/21 EMA 交叉 | 短期均线穿越长期均线 |
| 多指标共振 | 3 指标投票 | 至少 2 个指标同时确认 |
| 唐奇安通道突破 | 海龟交易法 | 突破 N 日高低点 |
| ATR 波动率 | 波动率放大检测 | ATR 异常 + 放量确认 |
| 成交量确认 | 放量方向确认 | 成交量 > 1.5倍均量 + RSI 方向确认 |

## 邮件通知格式

- 主题：`[BTC/USDT] 🟢 RSI 反转策略 - 建议关注`
- 内容：当前价格、指标数值、策略逻辑、建议入场/止损/目标价、风险收益比
- 精美 HTML 邮件，深色交易主题样式

## 免责声明

本工具仅提供信号提醒，**不自动执行交易**。过往表现不代表未来收益，交易需自行承担风险。

> AI生成
// Vercel Serverless API - Cron 触发的信号检测接口
// GET /api/check          → 检测全部币种
// GET /api/check?tier=1   → 仅检测 Tier1 主流币（15分钟cron用）
// GET /api/check?tier=2   → 仅检测 Tier2 热门币（1小时cron用）
// GET /api/check?tier=3   → 仅检测 Tier3 新锐币（4小时cron用）

import { checkTierSignals } from '../lib/checker.js';

function tierFromQuery(query) {
  const t = query.tier;
  if (t === '1') return 'tier1';
  if (t === '2') return 'tier2';
  if (t === '3') return 'tier3';
  return 'all';
}

export default async function handler(req, res) {
  // 仅允许 GET 请求
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 安全校验：如果设置了 CRON_SECRET，则验证请求头
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  const tier = tierFromQuery(req.query);

  try {
    const result = await checkTierSignals(tier);
    return res.status(200).json(result);
  } catch (err) {
    console.error('[API] Check failed:', err);
    return res.status(500).json({ error: err.message, timestamp: new Date().toISOString() });
  }
}

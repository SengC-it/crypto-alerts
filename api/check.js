// Vercel Serverless API - Cron 触发的信号检测接口
// GET /api/check          → 检测全部币种
// GET /api/check?tier=1   → 仅检测 Tier1 主流币
// GET /api/check?tier=2   → 仅检测 Tier2 热门币
// GET /api/check?tier=3   → 仅检测 Tier3 新锐币

import { checkTierSignals } from './lib/checker.js';
import { authorizeCronRequest } from '../src/api/auth.js';

function tierFromQuery(query) {
  const t = query?.tier;
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

  // Production cron endpoints fail closed when CRON_SECRET is missing.
  const authorization = authorizeCronRequest(req);
  if (!authorization.authorized) {
    const status = authorization.configured ? 401 : 503;
    return res.status(status).json({ error: authorization.reason || 'Unauthorized' });
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

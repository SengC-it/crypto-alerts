// Vercel Serverless API - Cron 触发的信号检测接口
// GET /api/check → 手动触发或由 Vercel Cron 调用

import { checkAllSignals } from '../lib/checker.js';

export default async function handler(req, res) {
  // 仅允许 GET 请求
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 简单的安全校验：如果设置了 CRON_SECRET，则验证请求头
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret) {
    const authHeader = req.headers['authorization'];
    if (authHeader !== `Bearer ${cronSecret}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
  }

  try {
    const result = await checkAllSignals();
    return res.status(200).json(result);
  } catch (err) {
    console.error('[API] Check failed:', err);
    return res.status(500).json({ error: err.message, timestamp: new Date().toISOString() });
  }
}

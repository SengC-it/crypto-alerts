// Vercel Serverless API - 健康检查
// GET /api/health

export default function handler(req, res) {
  return res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
  });
}

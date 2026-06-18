-- Crypto Alerts - Supabase 建表脚本
-- 在 Supabase SQL Editor 中执行此脚本

-- ============================================================
-- 1. 信号记录表
-- ============================================================
CREATE TABLE IF NOT EXISTS crypto_signals (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  dedupe_key    TEXT NOT NULL,                -- 去重键: "SYMBOL:STRATEGY:DIRECTION"
  symbol        TEXT NOT NULL,                -- 交易对: BTCUSDT
  strategy      TEXT NOT NULL,                -- 策略ID: rsi_reversal
  signal_direction TEXT NOT NULL CHECK (signal_direction IN ('BUY', 'SELL')),
  confidence    INTEGER NOT NULL DEFAULT 0,   -- 置信度 0-100
  reason        TEXT,                         -- 策略原因说明
  suggested_entry DOUBLE PRECISION,           -- 建议入场价
  stop_loss     DOUBLE PRECISION,             -- 止损价
  target_price  DOUBLE PRECISION,             -- 目标价
  risk_reward_ratio TEXT,                     -- 风险收益比: "1:2"
  indicators    JSONB,                        -- 指标数值快照
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 去重键 + 时间戳索引（用于去重查询）
CREATE INDEX IF NOT EXISTS idx_signals_dedupe_time
  ON crypto_signals (dedupe_key, created_at DESC);

-- 交易对索引（用于查询某交易对最近信号）
CREATE INDEX IF NOT EXISTS idx_signals_symbol_time
  ON crypto_signals (symbol, created_at DESC);

-- 创建时间索引
CREATE INDEX IF NOT EXISTS idx_signals_created_at
  ON crypto_signals (created_at DESC);

-- ============================================================
-- 2. 启用 RLS（行级安全）- 匿名只读，服务端全权
-- ============================================================
ALTER TABLE crypto_signals ENABLE ROW LEVEL SECURITY;

-- 匿名访问：只允许读取（用于 API 展示）
CREATE POLICY "Allow anonymous read access"
  ON crypto_signals FOR SELECT
  TO anon
  USING (true);

-- 服务端密钥：全部权限（用于写入信号）
CREATE POLICY "Allow service role full access"
  ON crypto_signals FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- 3. 自动清理超过30天的旧信号
-- ============================================================
CREATE OR REPLACE FUNCTION clean_old_signals()
RETURNS void AS $$
BEGIN
  DELETE FROM crypto_signals WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 使用 pg_cron 扩展定时执行（需在 Supabase Dashboard 启用 pg_cron 扩展）
-- 每天凌晨3点(UTC)执行清理
-- SELECT cron.schedule('clean-old-signals', '0 3 * * *', 'SELECT clean_old_signals()');

-- ============================================================
-- 4. 验证
-- ============================================================
-- 执行后可通过以下命令验证表创建成功：
-- SELECT * FROM crypto_signals LIMIT 5;

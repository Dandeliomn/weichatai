-- =============================================================================
-- 微信情感陪伴平台 v5 - 多微信账号桥接
-- 支持 WeClaw 多账号扫码登录后自动注册 bot 凭证
-- =============================================================================

-- 微信 Bot 账号表 — 存储每个已登录微信的认证信息
CREATE TABLE IF NOT EXISTS bot_accounts (
    id              SERIAL PRIMARY KEY,
    bot_id          VARCHAR(255) NOT NULL UNIQUE,     -- WeClaw Bot ID (如 xxx@im.bot)
    api_token       VARCHAR(500) NOT NULL,             -- 对应的 API Token
    wechat_id       VARCHAR(255),                      -- 微信原始ID (ToUserName)
    nickname        VARCHAR(255),                      -- 微信昵称 (可选)
    bot_index       INTEGER DEFAULT 0,                 -- Bot 索引 (0,1,2...)
    is_active       BOOLEAN DEFAULT TRUE,
    last_active_at  TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_bot_accounts_bot_id ON bot_accounts(bot_id);
CREATE INDEX IF NOT EXISTS idx_bot_accounts_wechat_id ON bot_accounts(wechat_id);
CREATE INDEX IF NOT EXISTS idx_bot_accounts_active ON bot_accounts(is_active);

-- 从 WeClaw 注册的 Bot，记录到老用户的 wechat_id 做关联
ALTER TABLE bot_accounts ADD COLUMN IF NOT EXISTS linked_user_id INTEGER REFERENCES user_accounts(id);

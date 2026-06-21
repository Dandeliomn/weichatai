-- =============================================================================
-- 微信情感陪伴平台 v3 - 媒体支持迁移
-- 为 conversation_logs 添加媒体字段，支持图片/表情包/语音/视频
-- =============================================================================

-- 1. conversation_logs 新增媒体字段
ALTER TABLE conversation_logs
    ADD COLUMN IF NOT EXISTS media_type VARCHAR(30),          -- image / sticker / voice / video / file
    ADD COLUMN IF NOT EXISTS media_url  TEXT,                  -- 媒体URL或本地路径
    ADD COLUMN IF NOT EXISTS media_data TEXT,                  -- base64编码的小文件 (<500KB)
    ADD COLUMN IF NOT EXISTS media_mime VARCHAR(100);          -- MIME type (image/png, image/gif等)

-- 索引: 按媒体类型查询
CREATE INDEX IF NOT EXISTS idx_conversations_media
    ON conversation_logs(media_type)
    WHERE media_type IS NOT NULL;

-- 2. 用户媒体存储配额表
CREATE TABLE IF NOT EXISTS user_media_storage (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    total_bytes     BIGINT DEFAULT 0,
    file_count      INTEGER DEFAULT 0,
    last_cleanup_at TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id)
);

-- 3. 媒体文件索引表 (独立存储，便于管理和清理)
CREATE TABLE IF NOT EXISTS media_files (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wechat_id       VARCHAR(255) NOT NULL,
    convo_log_id    INTEGER REFERENCES conversation_logs(id) ON DELETE SET NULL,
    file_path       TEXT,                                     -- 文件系统路径
    file_url        TEXT,                                     -- 访问URL
    file_size       INTEGER,                                  -- 字节
    media_type      VARCHAR(30) NOT NULL,                     -- image/sticker/voice/video/file
    mime_type       VARCHAR(100),
    sha256          VARCHAR(64),                              -- 去重用的文件哈希
    is_sticker      BOOLEAN DEFAULT FALSE,
    original_msg_id VARCHAR(255),                             -- 微信原始消息ID
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_media_user ON media_files(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_media_type ON media_files(media_type);
CREATE INDEX IF NOT EXISTS idx_media_hash ON media_files(sha256);  -- 去重查询

-- 4. 用户表情包收藏表
CREATE TABLE IF NOT EXISTS user_stickers (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wechat_id       VARCHAR(255) NOT NULL,
    sticker_name    VARCHAR(255),                             -- 表情包名称/描述
    file_url        TEXT NOT NULL,                             -- 可访问的文件URL
    file_path       TEXT,                                      -- 本地路径
    usage_count     INTEGER DEFAULT 1,                        -- 使用次数
    first_seen_at   TIMESTAMPTZ DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ DEFAULT NOW(),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_stickers_user ON user_stickers(user_id);

-- 5. 对话日志新增字段的触发器更新
CREATE TRIGGER update_media_storage_updated_at
    BEFORE UPDATE ON user_media_storage
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- 插入默认管理员账号的媒体配额
INSERT INTO user_media_storage (user_id, total_bytes, file_count)
SELECT id, 0, 0 FROM users
ON CONFLICT (user_id) DO NOTHING;

DO $$
BEGIN
    RAISE NOTICE '✅ v3 迁移完成: 媒体字段, media_files, user_stickers, user_media_storage';
END $$;

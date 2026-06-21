-- =============================================================================
-- 微信情感陪伴AI服务 - PostgreSQL 数据库初始化脚本
-- 在PostgreSQL容器首次启动时自动执行
-- =============================================================================

-- 启用UUID扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- =============================================================================
-- 1. 用户表 (users)
-- 存储每个微信用户的元信息
-- =============================================================================
CREATE TABLE IF NOT EXISTS users (
    id              SERIAL PRIMARY KEY,
    wechat_id       VARCHAR(255) UNIQUE NOT NULL,       -- 微信用户唯一标识 (FromUserName)
    nickname        VARCHAR(255),                        -- 用户昵称
    avatar_url      TEXT,                                -- 头像URL (预留)
    first_active_at TIMESTAMPTZ DEFAULT NOW(),           -- 首次互动时间
    last_active_at  TIMESTAMPTZ DEFAULT NOW(),           -- 最后互动时间
    total_messages  INTEGER DEFAULT 0,                   -- 累计消息数
    is_active       BOOLEAN DEFAULT TRUE,                -- 是否活跃
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 索引: 加速按微信ID查找
CREATE INDEX IF NOT EXISTS idx_users_wechat_id ON users(wechat_id);

-- 索引: 加速查找最近活跃用户 (用于主动关怀)
CREATE INDEX IF NOT EXISTS idx_users_last_active ON users(last_active_at DESC);

-- 索引: 活跃用户筛选
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active) WHERE is_active = TRUE;

-- =============================================================================
-- 2. 用户长期记忆表 (user_memories)
-- 存储由LLM生成的结构化记忆摘要
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_memories (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary_text    TEXT NOT NULL,                        -- 记忆摘要内容
    keywords        TEXT[],                               -- 关键词数组 (用于检索)
    emotion         VARCHAR(50),                          -- 关联情绪标签
    importance      INTEGER DEFAULT 1 CHECK (importance BETWEEN 1 AND 10), -- 重要性评分 1-10
    source_convo_id INTEGER,                             -- 来源对话ID (可选)
    memory_type     VARCHAR(50) DEFAULT 'factual',       -- 记忆类型: factual / preference / event / relationship
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 索引: 按用户和创建时间查询
CREATE INDEX IF NOT EXISTS idx_memories_user_id ON user_memories(user_id);

-- 索引: 全文搜索关键词 (使用GIN索引加速数组搜索)
CREATE INDEX IF NOT EXISTS idx_memories_keywords ON user_memories USING GIN(keywords);

-- 索引: 按重要性排序
CREATE INDEX IF NOT EXISTS idx_memories_importance ON user_memories(user_id, importance DESC);

-- 索引: 全文搜索摘要内容
CREATE INDEX IF NOT EXISTS idx_memories_summary_fts ON user_memories
    USING GIN (to_tsvector('simple', summary_text));

-- =============================================================================
-- 3. 对话日志表 (conversation_logs)
-- 记录所有对话历史，用于统计和长期记忆生成
-- =============================================================================
CREATE TABLE IF NOT EXISTS conversation_logs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wechat_id       VARCHAR(255) NOT NULL,               -- 冗余存储，加速查询
    role            VARCHAR(20) NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
    content         TEXT NOT NULL,                        -- 消息内容
    emotion         VARCHAR(50),                          -- 本条消息的情绪标签
    emotion_confidence FLOAT,                             -- 情绪识别置信度 0-1
    tokens_used     INTEGER,                              -- 消耗的token数 (如有)
    replied_at      TIMESTAMPTZ,                          -- 如果是user消息，AI回复的时间
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

-- 索引: 按用户和创建时间查询 (最常用的查询模式)
CREATE INDEX IF NOT EXISTS idx_conversations_user_time
    ON conversation_logs(user_id, created_at DESC);

-- 索引: 按微信ID查询
CREATE INDEX IF NOT EXISTS idx_conversations_wechat_id
    ON conversation_logs(wechat_id, created_at DESC);

-- 索引: 查询最近N天内的活跃用户 (用于主动关怀)
CREATE INDEX IF NOT EXISTS idx_conversations_recent
    ON conversation_logs(user_id, created_at DESC)
    WHERE created_at > NOW() - INTERVAL '7 days';

-- =============================================================================
-- 4. 每日摘要表 (daily_summaries)
-- 存储每个用户每天的对话摘要 (由LLM在后台生成)
-- =============================================================================
CREATE TABLE IF NOT EXISTS daily_summaries (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    summary_date    DATE NOT NULL,                        -- 摘要日期
    summary_text    TEXT NOT NULL,                        -- 摘要内容
    mood_summary    VARCHAR(255),                         -- 当日心情总结
    topic_keywords  TEXT[],                               -- 话题关键词
    message_count   INTEGER DEFAULT 0,                    -- 当日消息数
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    UNIQUE(user_id, summary_date)                         -- 每天每个用户一条
);

-- 索引: 按用户和日期查询
CREATE INDEX IF NOT EXISTS idx_summaries_user_date ON daily_summaries(user_id, summary_date DESC);

-- =============================================================================
-- 5. 关怀消息日志表 (care_message_logs)
-- 记录主动关怀的发送历史，避免重复发送
-- =============================================================================
CREATE TABLE IF NOT EXISTS care_message_logs (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message_text    TEXT NOT NULL,                        -- 发送的关怀内容
    schedule_type   VARCHAR(20) NOT NULL,                 -- 定时类型: morning / afternoon / evening
    sent_at         TIMESTAMPTZ DEFAULT NOW()
);

-- 索引: 查询某个用户在某个时段是否已发送
CREATE INDEX IF NOT EXISTS idx_care_logs_user_time
    ON care_message_logs(user_id, sent_at DESC);

-- =============================================================================
-- 触发器: 自动更新 updated_at 字段
-- =============================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- 为需要自动更新 updated_at 的表添加触发器
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_user_memories_updated_at
    BEFORE UPDATE ON user_memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 插入初始化完成标记
-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ 数据库初始化完成: 已创建 users, user_memories, conversation_logs, daily_summaries, care_message_logs 表';
END $$;

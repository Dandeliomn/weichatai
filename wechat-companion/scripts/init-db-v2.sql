-- =============================================================================
-- 微信情感陪伴平台 v2 - 新增表 (用户认证/画像/聊天导入/管理后台)
-- 运行方式: docker compose exec postgres psql -U weclaw -d weclaw_companion -f /docker-entrypoint-initdb.d/01-init-v2.sql
-- =============================================================================

-- =============================================================================
-- 1. 用户账号表 (user_accounts) — Web 登录认证
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_accounts (
    id              SERIAL PRIMARY KEY,
    email           VARCHAR(255) UNIQUE NOT NULL,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(100),
    role            VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
    wechat_id       VARCHAR(255),                          -- 关联的微信用户ID
    avatar_url      TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    refresh_token   TEXT,                                  -- 哈希存储
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_accounts_email ON user_accounts(email);
CREATE INDEX IF NOT EXISTS idx_accounts_role ON user_accounts(role);
CREATE INDEX IF NOT EXISTS idx_accounts_wechat ON user_accounts(wechat_id);

-- =============================================================================
-- 2. 用户资料表 (user_profiles) — AI 个性化画像
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_profiles (
    id                  SERIAL PRIMARY KEY,
    user_id             INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE UNIQUE,
    personality         TEXT,                              -- 性格特征描述
    communication_style TEXT,                              -- 沟通风格
    hobbies             TEXT[],                             -- 兴趣爱好
    keywords            TEXT[],                             -- 关键词/常用词汇
    relationship_focus  TEXT,                              -- 关注的关系类型
    custom_prompt       TEXT,                              -- 自定义 AI Prompt
    model_prefs         JSONB DEFAULT '{}',                -- AI 模型偏好设置
    import_task_id      INTEGER,                           -- 来源导入任务ID
    created_at          TIMESTAMPTZ DEFAULT NOW(),
    updated_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_profiles_user_id ON user_profiles(user_id);

-- =============================================================================
-- 3. 聊天记录导入任务表 (import_tasks)
-- =============================================================================
CREATE TABLE IF NOT EXISTS import_tasks (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
    filename        VARCHAR(500) NOT NULL,
    file_path       TEXT NOT NULL,                         -- 服务器上的文件路径
    file_size       BIGINT,                                -- 文件大小(字节)
    format          VARCHAR(50) NOT NULL DEFAULT 'auto',   -- html / json / csv / auto
    status          VARCHAR(30) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
    message_count   INTEGER DEFAULT 0,                     -- 解析出的消息数
    progress        INTEGER DEFAULT 0,                     -- 处理进度 0-100
    result_summary  TEXT,                                  -- AI 分析结果摘要
    error_message   TEXT,                                  -- 错误信息
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_import_user_id ON import_tasks(user_id);
CREATE INDEX IF NOT EXISTS idx_import_status ON import_tasks(status);

-- =============================================================================
-- 4. 导入的聊天消息表 (imported_messages)
-- =============================================================================
CREATE TABLE IF NOT EXISTS imported_messages (
    id              SERIAL PRIMARY KEY,
    task_id         INTEGER NOT NULL REFERENCES import_tasks(id) ON DELETE CASCADE,
    user_id         INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
    sender          VARCHAR(255) NOT NULL,                 -- 消息发送者昵称
    content         TEXT NOT NULL,                          -- 消息内容
    timestamp       TIMESTAMPTZ,                            -- 原始消息时间
    msg_type        VARCHAR(30) DEFAULT 'text',             -- text/image/video/file/emoji/system
    is_from_user    BOOLEAN DEFAULT FALSE,                  -- 是否来自当前用户本人
    seq_id          INTEGER,                                -- 原始顺序号
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_imported_task ON imported_messages(task_id);
CREATE INDEX IF NOT EXISTS idx_imported_user ON imported_messages(user_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_imported_sender ON imported_messages(task_id, sender);

-- =============================================================================
-- 5. 关怀文案模板表 (care_templates) — 管理后台可编辑
-- =============================================================================
CREATE TABLE IF NOT EXISTS care_templates (
    id              SERIAL PRIMARY KEY,
    schedule_type   VARCHAR(20) NOT NULL CHECK (schedule_type IN ('morning', 'afternoon', 'evening')),
    content         TEXT NOT NULL,
    sort_order      INTEGER DEFAULT 0,
    is_active       BOOLEAN DEFAULT TRUE,
    created_by      INTEGER REFERENCES user_accounts(id),
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_care_templates_type ON care_templates(schedule_type, is_active);

-- 插入默认关怀文案
INSERT INTO care_templates (schedule_type, content, sort_order) VALUES
    ('morning', '早安呀~ ☀️ 新的一天开始了，今天也要元气满满哦！', 1),
    ('morning', '早上好！🌅 昨晚睡得好吗？记得吃早餐呀~', 2),
    ('morning', '新的一天，新的开始 ✨ 早安，今天有什么计划吗？', 3),
    ('morning', '早安！🌻 愿你今天遇到的都是美好~', 4),
    ('morning', '起床了吗？🌞 新的一天，我还在呢~', 5),
    ('afternoon', '中午好呀~ 🍜 吃饭了吗？记得按时吃饭哦！', 1),
    ('afternoon', '午安！🌤️ 下午也要保持好心情~', 2),
    ('afternoon', '中午啦！😋 记得补充能量哦~', 3),
    ('afternoon', '午间问候~ 🌻 忙了一上午，休息一下吧 ☕', 4),
    ('afternoon', '中午好！💫 喝杯水，对身体好哦~', 5),
    ('evening', '晚上好呀~ 🌙 今天过得怎么样？', 1),
    ('evening', '晚安之前，想想今天有什么开心的事呢？🌟', 2),
    ('evening', '晚上好！🌛 忙了一天辛苦了~', 3),
    ('evening', '又到了安静的夜晚 🌌 有什么想聊聊的吗？', 4),
    ('evening', '睡前问候 💤 明天又是美好的一天！', 5)
ON CONFLICT DO NOTHING;

-- =============================================================================
-- 6. 管理员操作日志表 (admin_logs)
-- =============================================================================
CREATE TABLE IF NOT EXISTS admin_logs (
    id              SERIAL PRIMARY KEY,
    admin_id        INTEGER NOT NULL REFERENCES user_accounts(id),
    action          VARCHAR(100) NOT NULL,                  -- 操作类型
    target_type     VARCHAR(50),                            -- 目标类型 (user/import/template)
    target_id       INTEGER,                                -- 目标ID
    details         JSONB DEFAULT '{}',                     -- 操作详情
    ip_address      VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_logs_admin ON admin_logs(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_logs_target ON admin_logs(target_type, target_id);

-- =============================================================================
-- 7. 用户会话表 (user_sessions) — JWT refresh token 管理
-- =============================================================================
CREATE TABLE IF NOT EXISTS user_sessions (
    id              SERIAL PRIMARY KEY,
    user_id         INTEGER NOT NULL REFERENCES user_accounts(id) ON DELETE CASCADE,
    refresh_token   TEXT NOT NULL UNIQUE,
    expires_at      TIMESTAMPTZ NOT NULL,
    is_revoked      BOOLEAN DEFAULT FALSE,
    device_info     VARCHAR(500),
    ip_address      VARCHAR(50),
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON user_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON user_sessions(refresh_token);

-- =============================================================================
-- 触发器
-- =============================================================================
CREATE TRIGGER update_accounts_updated_at
    BEFORE UPDATE ON user_accounts
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_profiles_updated_at
    BEFORE UPDATE ON user_profiles
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_import_tasks_updated_at
    BEFORE UPDATE ON import_tasks
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_care_templates_updated_at
    BEFORE UPDATE ON care_templates
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- =============================================================================
-- 完成标记
-- =============================================================================
DO $$
BEGIN
    RAISE NOTICE '✅ v2 迁移完成: user_accounts, user_profiles, import_tasks, imported_messages, care_templates, admin_logs, user_sessions';
END $$;

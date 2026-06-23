-- v7: Memory Self-Evolution System
-- 记忆自进化：用户纠正 → PG验证 → 自动更正Lorebook

-- 1. Correction audit log
CREATE TABLE IF NOT EXISTS correction_logs (
    id              SERIAL PRIMARY KEY,
    character_name  VARCHAR(255) NOT NULL,
    claim           TEXT NOT NULL,
    verified_text   TEXT,
    confidence      VARCHAR(20) DEFAULT 'auto',
    evidence        JSONB DEFAULT '[]',
    previous_entry  JSONB,
    new_entry       JSONB,
    source          VARCHAR(50) DEFAULT 'user',
    status          VARCHAR(20) DEFAULT 'applied',
    created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_corrections_character
    ON correction_logs(character_name, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_corrections_status
    ON correction_logs(status);

-- 2. Enable pg_trgm for Chinese fuzzy search
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- 3. Add trigram index on imported_messages.content for Chinese text search
CREATE INDEX IF NOT EXISTS idx_imported_content_trgm
    ON imported_messages USING GIN (content gin_trgm_ops);

-- 4. Track correction count per character in system_config
INSERT INTO system_config (key, value)
VALUES ('correction_count_王静', '0')
ON CONFLICT (key) DO NOTHING;

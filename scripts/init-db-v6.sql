-- =============================================================================
-- v6: BridgePage 多 Bot 管理 — character_id 列
-- =============================================================================

-- bot_accounts 加角色关联
ALTER TABLE bot_accounts
  ADD COLUMN IF NOT EXISTS character_id INTEGER
  REFERENCES character_templates(id) ON DELETE SET NULL;

-- 索引加速按角色查询
CREATE INDEX IF NOT EXISTS idx_bot_accounts_character
  ON bot_accounts(character_id) WHERE character_id IS NOT NULL;

-- linked_user_id 索引 (已有列但未使用)
CREATE INDEX IF NOT EXISTS idx_bot_accounts_linked_user
  ON bot_accounts(linked_user_id) WHERE linked_user_id IS NOT NULL;

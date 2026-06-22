/**
 * 角色迁移脚本 — 将 PostgreSQL character_templates + Hermes 文件
 * 转换为 SillyTavern chara_card_v2 JSON 格式
 *
 * 用法: npx tsx scripts/convert-to-st-charcard.ts
 *
 * 输出到: st-data/default/characters/
 */

import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import 'dotenv/config';

// =============================================================================
// 配置
// =============================================================================

// 宿主机上 postgres 暴露在 127.0.0.1:5432; Docker 内部用 service name "postgres"
const DATABASE_URL =
  process.env.CONVERT_DB_URL ||
  process.env.DATABASE_URL?.replace('@postgres:', '@localhost:') ||
  'postgresql://weclaw:weclaw_secret@localhost:5432/weclaw_companion';

const OUTPUT_DIR = path.resolve(__dirname, '..', 'st-data', 'default', 'characters');
const HERMES_DIR = path.resolve(os.homedir(), '.hermes');

// =============================================================================
// 类型定义
// =============================================================================

/** SillyTavern chara_card_v2 规范 */
interface CharaCardV2 {
  spec: 'chara_card_v2';
  spec_version: '2.0';
  data: {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    system_prompt: string;
    post_history_instructions: string;
    tags: string[];
    creator_notes: string;
    character_version: string;
    extensions: Record<string, unknown>;
  };
}

/** PostgreSQL character_templates 行 (只读感兴趣的列) */
interface CharacterRow {
  name: string;
  tagline: string | null;
  description: string | null;
  personality: string | null;
  scenario: string | null;
  first_message: string | null;
  example_dialogue: string | null;
  system_prompt: string | null;
  post_history: string | null;
  tags: string[];
  metadata: Record<string, unknown> | null;
}

// =============================================================================
// 工具函数
// =============================================================================

/** 将可能的非安全文件名转为下划线形式 */
function safeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim();
}

/** 写出单个 chara_card JSON */
function writeCard(card: CharaCardV2): void {
  const filename = safeFilename(card.data.name) + '.json';
  const filepath = path.join(OUTPUT_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify(card, null, 2), 'utf-8');
  console.log(`  ✓ ${card.data.name} → ${filename}`);
}

// =============================================================================
// 来源 1: PostgreSQL character_templates
// =============================================================================

async function convertFromPostgres(pool: Pool): Promise<number> {
  const result = await pool.query<CharacterRow>(
    `SELECT name,
            tagline,
            description,
            personality,
            scenario,
            first_message,
            example_dialogue,
            system_prompt,
            post_history,
            tags,
            metadata
     FROM character_templates
     WHERE is_official = TRUE
        OR category IN ('preset', 'custom', 'imported')`
  );

  let count = 0;
  for (const row of result.rows) {
    // data.description 放 tagline + description
    const desc = [row.tagline, row.description].filter(Boolean).join('\n\n');

    const card: CharaCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: row.name,
        description: desc,
        personality: row.personality ?? '',
        scenario: row.scenario ?? '',
        first_mes: row.first_message ?? '',
        mes_example: row.example_dialogue ?? '',
        system_prompt: row.system_prompt ?? '',
        post_history_instructions: row.post_history ?? '',
        tags: row.tags ?? [],
        creator_notes: '',
        character_version: '1.0',
        extensions: (row.metadata as Record<string, unknown>) ?? {},
      },
    };

    writeCard(card);
    count++;
  }

  return count;
}

// =============================================================================
// 来源 2: Hermes 文件 (~/.hermes/SOUL.md + persona.txt)
// =============================================================================

function convertHermesFiles(): number {
  let count = 0;

  // ---- SOUL.md → "Change" 角色卡片 ----
  const soulPath = path.join(HERMES_DIR, 'SOUL.md');
  if (fs.existsSync(soulPath)) {
    const soulContent = fs.readFileSync(soulPath, 'utf-8');

    const card: CharaCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: 'Change',
        description: 'Hermes AI 灵魂伴侣 — Change',
        personality: soulContent,
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: soulContent,
        post_history_instructions: '',
        tags: ['hermes', 'ai', 'companion'],
        creator_notes: '自动转换自 Hermes SOUL.md',
        character_version: '1.0',
        extensions: { source: 'hermes', source_file: 'SOUL.md' },
      },
    };

    writeCard(card);
    count++;
  } else {
    console.log('  - SOUL.md 不存在，跳过');
  }

  // ---- persona.txt → "王静" 角色卡片 ----
  const personaPath = path.join(HERMES_DIR, 'persona.txt');
  if (fs.existsSync(personaPath)) {
    const personaContent = fs.readFileSync(personaPath, 'utf-8');

    // 从内容中提取一些统计信息作为 metadata
    const avgLen = personaContent.match(/平均每条消息(\d+\.?\d*)个字/);

    const card: CharaCardV2 = {
      spec: 'chara_card_v2',
      spec_version: '2.0',
      data: {
        name: '王静',
        description: '微信情感陪伴 AI — 王静',
        personality: personaContent,
        scenario: '',
        first_mes: '',
        mes_example: '',
        system_prompt: personaContent,
        post_history_instructions: '',
        tags: ['hermes', 'wechat', 'companion', '王静'],
        creator_notes: '自动转换自 Hermes persona.txt',
        character_version: '1.0',
        extensions: {
          source: 'hermes',
          source_file: 'persona.txt',
          avg_message_length: avgLen ? `${avgLen[1]} 字` : '',
        },
      },
    };

    writeCard(card);
    count++;
  } else {
    console.log('  - persona.txt 不存在，跳过');
  }

  return count;
}

// =============================================================================
// Main
// =============================================================================

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════');
  console.log('  角色迁移脚本 — PG → SillyTavern chara_card_v2');
  console.log('═══════════════════════════════════════════════');

  // 确保输出目录存在
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`\n📂 输出目录: ${OUTPUT_DIR}`);

  // ---- 来源 1: PostgreSQL ----
  console.log('\n🔍 从 PostgreSQL character_templates 查询...');

  let pgPool: Pool | null = null;
  let pgCount = 0;

  try {
    pgPool = new Pool({ connectionString: DATABASE_URL, max: 1 });
    pgCount = await convertFromPostgres(pgPool);
    console.log(`  ✅ 共导出 ${pgCount} 个角色`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ PostgreSQL 查询失败: ${msg}`);
    console.log('  ⚠️  跳过数据库角色，继续处理 Hermes 文件...');
  } finally {
    if (pgPool) await pgPool.end();
  }

  // ---- 来源 2: Hermes 文件 ----
  console.log(`\n🔍 从 Hermes 目录 (${HERMES_DIR}) 转换...`);
  const hermesCount = convertHermesFiles();
  console.log(`  ✅ 共转换 ${hermesCount} 个文件`);

  // ---- 汇总 ----
  const total = pgCount + hermesCount;
  console.log('\n═══════════════════════════════════════════════');
  console.log(`  🎉 完成! 共写入 ${total} 个角色卡片`);
  console.log(`  📁 ${OUTPUT_DIR}`);

  // 列出输出文件
  const files = fs.readdirSync(OUTPUT_DIR).filter(f => f.endsWith('.json'));
  if (files.length > 0) {
    console.log('\n📄 输出文件:');
    for (const f of files) {
      const stat = fs.statSync(path.join(OUTPUT_DIR, f));
      console.log(`  ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
    }
  }
}

main().catch((err) => {
  console.error('\n❌ 脚本执行失败:', err);
  process.exit(1);
});

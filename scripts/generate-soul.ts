/**
 * SOUL.md 生成脚本
 * 从 PostgreSQL 聊天记录 + 结构化记忆中提取静静的人格特征
 *
 * 用法: npx ts-node scripts/generate-soul.ts
 */

import { Pool } from 'pg';
import 'dotenv/config';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://weclaw:weclaw_secret@postgres:5432/weclaw_companion';
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';

const pool = new Pool({ connectionString: DATABASE_URL, max: 5 });

interface Message {
  sender: string;
  content: string;
  timestamp: Date;
}

interface Memory {
  summary_text: string;
  emotion: string | null;
  keywords: string[];
}

async function main() {
  console.log('[SOUL] 🔍 从数据库抽取数据...');

  // 1. 抽取静静的聊天记录（均匀采样 ~3000 条）
  const msgsResult = await pool.query<Message>(
    `SELECT sender, content, timestamp
     FROM imported_messages
     WHERE sender = '静静'
     ORDER BY timestamp
     LIMIT 4000`
  );
  const allMsgs = msgsResult.rows;
  const sampledMsgs = sampleUniform(allMsgs, 3000);
  console.log(`[SOUL] 📊 聊天记录: ${allMsgs.length} 条总, 采样 ${sampledMsgs.length} 条`);

  // 2. 抽取结构化记忆
  const memResult = await pool.query<Memory>(
    `SELECT summary_text, emotion, keywords FROM user_memories ORDER BY importance DESC LIMIT 200`
  );
  const memories = memResult.rows;
  console.log(`[SOUL] 🧠 结构化记忆: ${memories.length} 条`);

  // 3. 分批分析 (500条/批)
  const BATCH_SIZE = 500;
  const batches: string[] = [];
  for (let i = 0; i < sampledMsgs.length; i += BATCH_SIZE) {
    const batch = sampledMsgs.slice(i, i + BATCH_SIZE);
    batches.push(batch.map(m => `[${m.sender}] ${m.content}`).join('\n'));
  }
  console.log(`[SOUL] 📦 分 ${batches.length} 批分析...`);

  const batchInsights: string[] = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`[SOUL] 🔄 分析第 ${i + 1}/${batches.length} 批...`);
    const insight = await analyzeBatch(batches[i], i + 1);
    batchInsights.push(insight);
  }

  // 4. 汇总合并 + 融合记忆
  const soulMd = await generateFinalSoul(batchInsights, memories);
  console.log('[SOUL] ✅ 生成完成!\n');
  console.log(soulMd);

  await pool.end();
}

function sampleUniform<T>(arr: T[], target: number): T[] {
  if (arr.length <= target) return arr;
  const step = arr.length / target;
  const result: T[] = [];
  for (let i = 0; i < target; i++) {
    result.push(arr[Math.floor(i * step)]);
  }
  return result;
}

async function analyzeBatch(messages: string, batchNum: number): Promise<string> {
  const res = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `以下是"静静"的一段聊天记录（第${batchNum}批）。请提取她的语言特征、说话风格、常用词、emoji偏好、情感模式：

${messages.substring(0, 30000)}

请用中文输出分析结果，每行一个特征，格式: "- 特征描述"`,
      }],
      temperature: 0.3,
      max_tokens: 800,
    }),
  });
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

async function generateFinalSoul(batchInsights: string[], memories: Memory[]): Promise<string> {
  const memoryText = memories.map(m =>
    `- ${m.summary_text} (情感: ${m.emotion || '未知'})`
  ).join('\n');

  const res = await fetch(`${DEEPSEEK_BASE_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [{
        role: 'user',
        content: `你是静静的角色设计师。请综合以下信息，生成一份完整的 SOUL.md 人格文件。

## 分批分析结果
${batchInsights.join('\n\n')}

## 结构化记忆
${memoryText}

## 输出格式
请严格按照以下 Markdown 格式输出（不要输出任何其他内容）：

# Personality
[3-5句话定义静静的性格核心、价值观、情感模式]

## Language Style
- [语言特征，至少8条，包含：句长偏好、常用语气词、emoji偏好、标点习惯、回复速度、话多话少、是否用网络用语]

## Relationship Memory
- [关键关系，至少5条，包含：重要的人、相处方式、共同经历]

## What to avoid
- [至少5条行为守则：什么不能说、什么语气不能用、什么话题要避免]

## Catchphrases
- [高频表达，列5-10个]`,
      }],
      temperature: 0.5,
      max_tokens: 2000,
    }),
  });
  const data = await res.json() as any;
  return data.choices?.[0]?.message?.content || '';
}

main().catch(console.error);

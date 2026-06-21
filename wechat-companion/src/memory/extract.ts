/**
 * 结构化记忆提取 — 从导入的聊天记录中提炼关键信息
 *
 * 参照 ex-skill 的记忆架构:
 * - 关键事件 & 时间线
 * - 说话风格 & 口头禅
 * - 常聊话题 & inside jokes
 * - 关系动态 & 互动模式
 */

import { Pool } from 'pg';
import axios from 'axios';

const BATCH_SIZE = 80;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || '';
const DEEPSEEK_BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat';

interface ExtractedMemory {
  summary: string;
  keywords: string[];
  category: string;
  importance: number;
}

/**
 * 从采样消息中提取结构化记忆
 */
async function extractFromBatch(
  messages: Array<{ sender: string; content: string; timestamp: string }>,
  aiName: string,
  userName: string,
  category: string
): Promise<ExtractedMemory[]> {
  const conversation = messages
    .map((m) => {
      const ts = m.timestamp ? new Date(m.timestamp).toLocaleDateString('zh-CN') : '';
      const label = m.sender === aiName ? aiName : userName;
      return `[${ts}] ${label}: ${m.content}`;
    })
    .join('\n');

  const prompt = `你是聊天记录分析师。从以下${aiName}和${userName}的微信对话中，提取重要的结构化记忆。

## 对话内容
${conversation}

## 提取要求
请提取以下类别的重要信息（每个类别输出 1-5 条，用 JSON 数组格式）：

1. **关键事件**：重要的对话片段、转折点、有意义的互动
2. **说话风格**：${aiName}的说话特点（语气词、口头禅、emoji习惯、标点风格、消息长度）
3. **常聊话题**：经常讨论的主题、inside jokes、共同关心的事
4. **关系动态**：互动模式、情绪表达方式、相处特点

## 输出格式
返回严格的 JSON 数组，不要包含其他文字：
[
  {"summary": "一句话描述（15-50字）", "keywords": ["关键词1","关键词2","关键词3"], "category": "关键事件", "importance": 8},
  ...
]

importance: 1-10, 越重要越高。关键事件 8-10, 说话风格 5-7, 话题 5-7, 关系 6-8。

每条 summary 必须是独立、完整的中文句子。从对话中提取真实信息，不要虚构。`;

  try {
    const resp = await axios.post(
      `${DEEPSEEK_BASE_URL}/v1/chat/completions`,
      {
        model: DEEPSEEK_MODEL,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.3,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      },
      {
        headers: {
          Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    const text = resp.data?.choices?.[0]?.message?.content || '';
    // 尝试解析 JSON
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      const items = JSON.parse(jsonMatch[0]);
      return items.filter(
        (item: any) =>
          item.summary &&
          item.summary.length >= 5 &&
          Array.isArray(item.keywords) &&
          item.keywords.length > 0
      ).map((item: any) => ({
        summary: item.summary.substring(0, 300),
        keywords: item.keywords.slice(0, 8),
        category: item.category || category,
        importance: Math.min(10, Math.max(1, item.importance || 5)),
      }));
    }

    console.warn('[Extract] JSON 解析失败，原文:', text.substring(0, 200));
    return [];
  } catch (e: any) {
    console.error('[Extract] DeepSeek 调用失败:', e.message);
    return [];
  }
}

/**
 * 从导入任务中采样消息
 */
async function sampleMessages(
  pgPool: Pool,
  limit: number
): Promise<{ messages: Array<{ sender: string; content: string; timestamp: string }>; total: number }> {
  const task = await pgPool.query(
    `SELECT id, meta FROM import_tasks WHERE status = 'done' ORDER BY created_at DESC LIMIT 1`
  );
  if (task.rows.length === 0) return { messages: [], total: 0 };

  const taskId = task.rows[0].id;
  const meta = task.rows[0].meta || {};
  const aiName = meta.aiName || 'AI';

  const count = await pgPool.query(
    `SELECT COUNT(*) as cnt FROM imported_messages WHERE task_id = $1`,
    [taskId]
  );
  const total = parseInt(count.rows[0]?.cnt || '0');

  if (total === 0) return { messages: [], total: 0 };

  // 均匀采样（取有意义的消息，跳过太短的和系统消息）
  const step = Math.max(1, Math.floor(total / Math.min(limit, total)));
  const samples: Array<{ sender: string; content: string; timestamp: string }> = [];

  for (let i = 0; i < Math.min(limit, total); i++) {
    const offset = Math.min(i * step, total - 1);
    const row = await pgPool.query(
      `SELECT sender, content, timestamp FROM imported_messages
       WHERE task_id = $1 AND length(content) > 5
       ORDER BY timestamp ASC OFFSET $2 LIMIT 1`,
      [taskId, offset]
    );
    if (row.rows.length > 0) {
      samples.push(row.rows[0]);
    }
  }

  return { messages: samples, total };
}

/**
 * 主入口：提取并存储结构化记忆
 * @returns 提取的记忆数量
 */
export async function extractStructuredMemories(pgPool: Pool): Promise<number> {
  if (!DEEPSEEK_API_KEY || DEEPSEEK_API_KEY === 'sk-your-deepseek-api-key-here') {
    console.warn('[Extract] ⚠️  DeepSeek API Key 未配置，跳过记忆提取');
    return 0;
  }

  console.log('[Extract] 🔍 开始提取结构化记忆...');

  const { messages, total } = await sampleMessages(pgPool, 300);
  if (messages.length === 0) {
    console.log('[Extract] 无可用消息');
    return 0;
  }

  console.log(`[Extract] 采样 ${messages.length}/${total} 条消息`);

  // 读取导入任务的 meta 获取角色名
  const taskMeta = await pgPool.query(
    `SELECT id, user_id, meta FROM import_tasks WHERE status = 'done' ORDER BY created_at DESC LIMIT 1`
  );
  const userId = taskMeta.rows[0]?.user_id || 1;
  const meta = taskMeta.rows[0]?.meta || {};
  const aiName = meta.aiName || 'AI';
  const userName = meta.userName || '用户';

  // 获取 users 表的 ID（user_memories.user_id 引用 users.id）
  const userInfo = await pgPool.query(
    `SELECT id FROM users WHERE wechat_id ILIKE '%@im.wechat%' LIMIT 1`
  );
  const memoryUserId = userInfo.rows[0]?.id || 1;

  // 分批次提取
  const batchCount = Math.ceil(messages.length / BATCH_SIZE);
  let totalExtracted = 0;

  for (let i = 0; i < batchCount; i++) {
    const batch = messages.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE);
    console.log(`[Extract] 批次 ${i + 1}/${batchCount} (${batch.length} 条消息)`);

    const category = i < batchCount / 2 ? '关键事件' : '关系动态';
    const memories = await extractFromBatch(batch, aiName, userName, category);

    if (memories.length === 0) {
      console.log(`[Extract] 批次 ${i + 1} 未提取到有效记忆`);
      continue;
    }

    // 批量写入数据库（去重）
    for (const mem of memories) {
      try {
        // 检查是否已有相似记忆
        const existing = await pgPool.query(
          `SELECT id FROM user_memories
           WHERE user_id = $1 AND summary_text ILIKE $2 LIMIT 1`,
          [memoryUserId, `%${mem.summary.substring(0, 30)}%`]
        );

        if (existing.rows.length > 0) {
          // 更新已有记忆（合并关键词）
          await pgPool.query(
            `UPDATE user_memories
             SET keywords = array_cat(keywords, $3::text[]),
                 importance = GREATEST(importance, $4),
                 updated_at = NOW()
             WHERE id = $1`,
            [existing.rows[0].id, mem.keywords, mem.importance]
          );
        } else {
          await pgPool.query(
            `INSERT INTO user_memories (user_id, summary_text, keywords, emotion, importance, memory_type)
             VALUES ($1, $2, $3, 'neutral', $4, 'factual')`,
            [memoryUserId, mem.summary, mem.keywords, mem.importance]
          );
        }
        totalExtracted++;
      } catch (e: any) {
        console.warn(`[Extract] 写入失败: ${e.message}`);
      }
    }

    console.log(`[Extract] 批次 ${i + 1} 提取 ${memories.length} 条`);
  }

  console.log(`[Extract] ✅ 完成! 共提取 ${totalExtracted} 条结构化记忆`);
  return totalExtracted;
}

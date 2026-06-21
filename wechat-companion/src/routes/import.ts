/**
 * 聊天记录导入路由
 *
 * POST /api/import/upload      — 上传聊天记录文件
 * POST /api/import/weflow-api  — 接收 WeFlow API 提取的数据 (含base64表情包)
 * GET  /api/import/status/:id  — 查看处理进度
 * GET  /api/import/analysis/:id— 获取 AI 分析结果
 * POST /api/import/apply       — 将分析结果应用到 AI 陪伴
 */

import { Router, Request, Response } from 'express';
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import fs from 'fs';
import path from 'path';
import { authenticate } from '../middleware/auth';
import { handleUpload } from '../middleware/upload';

const router = Router();

let pgPool: Pool;
let importQueue: Queue;

export function initImportRoutes(pool: Pool, redis: Redis): void {
  pgPool = pool;
  importQueue = new Queue('chat-import', { connection: redis as any });
}

// 所有路由需要认证
router.use(authenticate);

// =============================================================================
// GET /api/import/tasks — 用户导入任务列表
// =============================================================================
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const result = await pgPool.query(
      'SELECT id, filename, status, message_count, created_at FROM import_tasks WHERE user_id=$1 ORDER BY created_at DESC LIMIT 20',
      [req.user!.userId]
    );
    res.json({ tasks: result.rows });
  } catch (error: any) { res.status(500).json({ error: '获取失败' }); }
});

// =============================================================================
// POST /api/import/presign — 获取 MinIO 预签名上传 URL (大文件直传)
// body: { filename, fileSize, contentType? }
// =============================================================================
router.post('/presign', async (req: Request, res: Response) => {
  try {
    const { filename, fileSize, contentType } = req.body;
    if (!filename) { res.status(400).json({ error: '缺少文件名' }); return; }

    // 尝试 MinIO
    const Minio = require('minio');
    const endPoint = process.env.MINIO_ENDPOINT;
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;
    const bucket = process.env.MINIO_BUCKET || 'weclaw-uploads';

    if (!endPoint || !accessKey || !secretKey) {
      // MinIO 未配置，回退到传统上传
      res.json({ method: 'direct', message: 'MinIO 未配置，请使用普通上传' });
      return;
    }

    // 创建两个 client:
    // 1) 内部 client — 连接 minio:9000 做 bucket 操作
    const internalClient = new Minio.Client({
      endPoint,
      port: parseInt(process.env.MINIO_PORT || '9000', 10),
      useSSL: process.env.MINIO_USE_SSL === 'true',
      accessKey, secretKey,
    });

    // 确保 bucket 存在
    const exists = await internalClient.bucketExists(bucket);
    if (!exists) await internalClient.makeBucket(bucket);

    // 创建导入任务记录
    const taskResult = await pgPool.query(
      `INSERT INTO import_tasks (user_id, filename, file_path, file_size, format, status)
       VALUES ($1, $2, $3, $4, 'auto', 'pending')
       RETURNING id`,
      [req.user!.userId, filename, `minio://${bucket}/${filename}`, fileSize || 0]
    );
    const taskId = taskResult.rows[0].id;
    const objectKey = `imports/${req.user!.userId}/${taskId}/${filename}`;

    // 2) 外部 client — 签名的 Host=浏览器地址, 但实际连接=内部 minio:9000
    const externalHost = (req.get('host') || 'localhost').split(':')[0];
    const externalPort = parseInt(process.env.MINIO_PORT || '9000', 10);
    const { Socket } = require('net');

    // 自定义 Agent: 连接到内网 minio 但签名/URL 用外部 host
    class PassthroughAgent extends require('http').Agent {
      createConnection(options: any, cb: any) {
        // 实际连接始终去 minio 容器
        const socket = Socket.connect(parseInt(process.env.MINIO_PORT || '9000'), endPoint);
        socket.on('connect', () => cb(null, socket));
        socket.on('error', (err: any) => cb(err, null));
      }
    }

    const externalClient = new Minio.Client({
      endPoint: externalHost,
      port: externalPort,
      useSSL: false,
      accessKey, secretKey,
      transport: new PassthroughAgent(),
    });
    const uploadUrl = await externalClient.presignedPutObject(bucket, objectKey, 3600);
    console.log(`[Import] MinIO presigned: ${filename} → ${objectKey} (host=${externalHost})`);

    res.json({
      method: 'minio',
      uploadUrl,
      objectKey,
      bucket,
      taskId,
      expiresIn: 3600,
    });
  } catch (error: any) {
    console.error('[Import] presign 失败:', error.message);
    res.status(500).json({ error: '生成上传链接失败' });
  }
});

// =============================================================================
// POST /api/import/confirm — MinIO 上传完成后确认，触发后台处理
// body: { taskId, bucket, objectKey }
// =============================================================================
router.post('/confirm', async (req: Request, res: Response) => {
  try {
    const { taskId, bucket, objectKey } = req.body;
    if (!taskId) { res.status(400).json({ error: '缺少 taskId' }); return; }

    const Minio = require('minio');
    const endPoint = process.env.MINIO_ENDPOINT;
    const accessKey = process.env.MINIO_ACCESS_KEY;
    const secretKey = process.env.MINIO_SECRET_KEY;

    if (endPoint && accessKey && secretKey) {
      const client = new Minio.Client({
        endPoint,
        port: parseInt(process.env.MINIO_PORT || '9000', 10),
        useSSL: process.env.MINIO_USE_SSL === 'true',
        accessKey, secretKey,
      });

      // 验证文件是否存在
      const stat = await client.statObject(bucket, objectKey);
      console.log(`[Import] MinIO 文件确认: ${objectKey} (${(stat.size/1024/1024).toFixed(1)}MB)`);

      // 下载到本地供 worker 处理
      const downloadDir = `/app/uploads/minio-downloads`;
      const fs = require('fs');
      fs.mkdirSync(downloadDir, { recursive: true });
      const localPath = `${downloadDir}/import_${taskId}_${require('path').basename(objectKey)}`;
      await client.fGetObject(bucket, objectKey, localPath);

      const fileSize = stat.size;

      // 更新任务 + 入队处理
      await pgPool.query(
        `UPDATE import_tasks SET file_path=$1, file_size=$2, status='pending' WHERE id=$3`,
        [localPath, fileSize, taskId]
      );

      await importQueue.add('parse-chat', {
        taskId, userId: req.user!.userId,
        filePath: localPath, filename: require('path').basename(objectKey), format: 'auto',
        stickerList: [], extractDir: '',
      });

      // 清理 MinIO 上的文件
      client.removeObject(bucket, objectKey).catch(() => {});

      res.json({ taskId, message: '文件已确认，后台处理中...', fileSize });
    } else {
      res.status(400).json({ error: 'MinIO 未配置' });
    }
  } catch (error: any) {
    console.error('[Import] confirm 失败:', error.message);
    res.status(500).json({ error: '确认失败: ' + error.message });
  }
});

// =============================================================================
// POST /api/import/upload — 小文件普通上传 (保留兼容)
// =============================================================================
router.post('/upload', handleUpload, async (req: Request, res: Response) => {
  try {
    const file = req.file;

    if (!file) {
      res.status(400).json({ error: '请选择要上传的文件' });
      return;
    }

    // 创建导入任务
    const result = await pgPool.query(
      `INSERT INTO import_tasks (user_id, filename, file_path, file_size, format, status)
       VALUES ($1, $2, $3, $4, $5, 'pending')
       RETURNING id`,
      [
        req.user!.userId,
        file.originalname,
        file.path,
        file.size,
        "auto",
      ]
    );

    const taskId = result.rows[0].id;

    // 如果是压缩包，先解压 (快速)，其他交给 worker 异步处理
    let finalPath: string | null = file.path;
    let finalFilename = file.originalname;
    const ext = path.extname(file.originalname).toLowerCase();
    const isArchive = ['.zip', '.gz', '.tgz'].includes(ext) || file.originalname.endsWith('.tar.gz');
    let stickerCount = 0;
    let chatFileCount = 0;
    const stickerExts = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];

    if (isArchive) {
      const extractDir = path.join(path.dirname(file.path), 'extracted_' + taskId);
      fs.mkdirSync(extractDir, { recursive: true });
      try {
        const { execSync } = require('child_process');
        if (ext === '.zip') {
          try {
            execSync(`unzip -o -O CP936 "${file.path}" -d "${extractDir}"`, { timeout: 30000, stdio: 'pipe' });
          } catch (e: any) {
            try {
              execSync(`unzip -o "${file.path}" -d "${extractDir}"`, { timeout: 30000, stdio: 'pipe' });
            } catch (e2: any) {
              console.error('[Import] unzip failed:', e.stderr?.toString(), e2.stderr?.toString());
              res.status(400).json({ error: '压缩包解压失败，请确认文件未损坏且有权限' });
              return;
            }
          }
        } else {
          try {
            execSync(`tar -xzf "${file.path}" -C "${extractDir}"`, { timeout: 30000, stdio: 'pipe' });
          } catch (e: any) {
            res.status(400).json({ error: '压缩包解压失败，请确认文件格式正确' });
            return;
          }
        }

        // 快速扫描目录 (不复制文件)
        const chatExts = ['.html', '.htm', '.json', '.csv', '.txt'];
        const stickerList: string[] = [];
        const chatFiles: string[] = [];
        function walkDir(dir: string) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walkDir(full); }
            else {
              const e = path.extname(entry.name).toLowerCase();
              if (chatExts.includes(e)) chatFiles.push(full);
              if (stickerExts.includes(e)) stickerList.push(full);
            }
          }
        }
        walkDir(extractDir);
        chatFileCount = chatFiles.length;
        stickerCount = stickerList.length;

        // 复制聊天文件到安全路径
        if (chatFiles.length > 0) {
          const safeExt = path.extname(chatFiles[0]);
          const safePath = path.join(extractDir, `chat_${taskId}${safeExt}`);
          try {
            fs.copyFileSync(chatFiles[0], safePath);
          } catch {
            const fallback = findFileByExt(extractDir, safeExt);
            if (fallback) { fs.renameSync(fallback, safePath); }
          }
          finalPath = safePath;
          finalFilename = `chat_${taskId}${safeExt}`;
        } else {
          finalPath = null;
          finalFilename = '';
        }

        console.log(`[Import] 压缩包扫描完成: 聊天=${chatFileCount}, 表情=${stickerCount}`);

        // 把表情包复制 + 聊天解析全部交给 worker，响应立即返回
        const metaPayload = { chatFiles: chatFileCount, stickers: stickerCount, isArchive };
        await pgPool.query(`UPDATE import_tasks SET meta=$1::jsonb WHERE id=$2`, [JSON.stringify(metaPayload), taskId]);

        await importQueue.add('parse-chat', {
          taskId, userId: req.user!.userId,
          filePath: finalPath, filename: finalFilename, format: 'auto',
          extractDir,  // worker 需要从这个目录复制表情包
          stickerList, // 表情包完整路径列表
          userStickerDir: `/app/stickers/${req.user!.userId}`,
        });

        res.status(201).json({
          taskId, filename: file.originalname,
          message: `已解压: ${chatFileCount} 个聊天文件, ${stickerCount} 个表情包，后台处理中...`,
          stats: { chatFiles: chatFileCount, stickers: stickerCount, isArchive },
          status: 'pending',
        });
        return;
      } catch (e: any) {
        console.error('[Import] 解压失败:', e.message);
        res.status(400).json({ error: '压缩包解压失败' });
        return;
      }
    }

    // 非压缩包 — 单文件
    const nonArchiveStickerExts = ['.gif', '.png', '.jpg', '.jpeg', '.webp'];
    if (nonArchiveStickerExts.includes(ext)) {
      const userStickerDir = `/app/stickers/${req.user!.userId}`;
      try { fs.mkdirSync(userStickerDir, { recursive: true, mode: 0o777 }); } catch {}
      fs.copyFileSync(file.path, path.join(userStickerDir, file.originalname));
      stickerCount = 1;
    }

    const metaPayload = { chatFiles: chatFileCount, stickers: stickerCount, isArchive };
    await pgPool.query(`UPDATE import_tasks SET meta=$1::jsonb WHERE id=$2`, [JSON.stringify(metaPayload), taskId]);

    if (finalPath) {
      await importQueue.add('parse-chat', { taskId, userId: req.user!.userId, filePath: finalPath, filename: finalFilename, format: 'auto', stickerList: [], extractDir: '' });
    } else {
      await pgPool.query(`UPDATE import_tasks SET status='done', message_count=0 WHERE id=$1`, [taskId]);
    }
    res.status(201).json({
      taskId, filename: file.originalname,
      message: finalPath ? `后台处理中...` : `已提取 ${stickerCount} 个表情包`,
      stats: { chatFiles: chatFileCount, stickers: stickerCount, isArchive },
      status: finalPath ? 'pending' : 'done',
    });
  } catch (error: any) {
    console.error('[Import] 上传失败:', error.message);
    res.status(500).json({ error: '上传失败' });
  }
});

// =============================================================================
// POST /api/import/weflow-api — 接收 WeFlow API 提取的完整数据
// 从本地提取脚本直接POST过来，包含base64媒体数据
// =============================================================================
router.post('/weflow-api', async (req: Request, res: Response) => {
  try {
    const bundle = req.body;

    // 验证格式
    if (!bundle || bundle.exporter !== 'weflow-api') {
      res.status(400).json({ error: '数据格式不正确，需要 WeFlow API export bundle' });
      return;
    }

    if (!Array.isArray(bundle.messages) || bundle.messages.length === 0) {
      res.status(400).json({ error: '消息数据为空' });
      return;
    }

    // 保存到文件 (用于持久化)
    const timestamp = Date.now();
    const safeName = (bundle.contact?.name || 'unknown').replace(/[^a-zA-Z0-9一-龥_-]/g, '_');
    const filename = `weflow-api_${safeName}_${timestamp}.json`;
    const fileDir = path.join(process.env.UPLOAD_DIR || 'uploads', 'weflow-api');
    fs.mkdirSync(fileDir, { recursive: true });
    const filePath = path.join(fileDir, filename);
    fs.writeFileSync(filePath, JSON.stringify(bundle));

    // 获取消息统计
    const messageCount = bundle.messages.length;
    const stickerCount = bundle.messages.filter(
      (m: any) => ['sticker', 'emoji'].includes(m.msgType)
    ).length;
    const imageCount = bundle.messages.filter(
      (m: any) => m.msgType === 'image'
    ).length;

    console.log(
      `[Import-WeFlow] 收到数据: ${messageCount}条消息 ` +
      `(表情:${stickerCount}, 图片:${imageCount}, ` +
      `联系人:${bundle.contact?.name || '未知'})`
    );

    // 创建导入任务
    const result = await pgPool.query(
      `INSERT INTO import_tasks (user_id, filename, file_path, file_size, format, status, message_count)
       VALUES ($1, $2, $3, $4, 'weflow-api', 'pending', $5)
       RETURNING id`,
      [
        req.user!.userId,
        `WeFlow API: ${bundle.contact?.name || '未知'}`,
        filePath,
        fs.statSync(filePath).size,
        messageCount,
      ]
    );

    const taskId = result.rows[0].id;

    // 加入处理队列
    await importQueue.add('parse-chat', {
      taskId,
      userId: req.user!.userId,
      filePath,
      filename: `WeFlow API: ${bundle.contact?.name || '未知'}`,
      format: 'weflow-api',
      // 额外传递联系人信息
      contactName: bundle.contact?.name,
      contactRemark: bundle.contact?.remark,
    });

    console.log(`[Import-WeFlow] 任务已创建: taskId=${taskId}`);

    res.status(201).json({
      taskId,
      message: '数据已接收，正在处理中...',
      stats: {
        totalMessages: messageCount,
        stickerCount,
        imageCount,
      },
    });
  } catch (error: any) {
    console.error('[Import-WeFlow] 接收失败:', error.message);
    res.status(500).json({ error: '数据接收失败' });
  }
});

// =============================================================================
// GET /api/import/status/:id
// =============================================================================
router.get('/status/:id', async (req: Request, res: Response) => {
  try {
    const taskId = parseInt(req.params.id as string);

    const result = await pgPool.query(
      `SELECT * FROM import_tasks WHERE id = $1 AND user_id = $2`,
      [taskId, req.user!.userId]
    );

    if (result.rows.length === 0) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }

    const task = result.rows[0];

    // 如果已完成，附带消息摘要
    let messageSample: any[] = [];
    if (task.status === 'done') {
      const messages = await pgPool.query(
        `SELECT sender, content, timestamp, msg_type
         FROM imported_messages
         WHERE task_id = $1
         ORDER BY timestamp
         LIMIT 10`,
        [taskId]
      );
      messageSample = messages.rows;
    }

    res.json({
      task: {
        id: task.id,
        filename: task.filename,
        fileSize: task.file_size,
        format: task.format,
        status: task.status,
        progress: task.progress,
        messageCount: task.message_count,
        meta: task.meta || {},
        resultSummary: task.result_summary,
        errorMessage: task.error_message,
        createdAt: task.created_at,
      },
      messageSample,
    });
  } catch (error: any) {
    res.status(500).json({ error: '获取状态失败' });
  }
});

// =============================================================================
// GET /api/import/analysis/:id
// =============================================================================
router.get('/analysis/:id', async (req: Request, res: Response) => {
  try {
    const taskId = parseInt(req.params.id as string);

    const task = await pgPool.query(
      `SELECT * FROM import_tasks WHERE id = $1 AND user_id = $2`,
      [taskId, req.user!.userId]
    );

    if (task.rows.length === 0) {
      res.status(404).json({ error: '任务不存在' });
      return;
    }

    if (task.rows[0].status !== 'done') {
      res.status(400).json({ error: '任务尚未完成处理' });
      return;
    }

    // 获取发送者统计
    const senderStats = await pgPool.query(
      `SELECT sender, COUNT(*) as count,
              COUNT(*) FILTER (WHERE msg_type != 'text') as media_count,
              MIN(timestamp) as first_msg,
              MAX(timestamp) as last_msg
       FROM imported_messages
       WHERE task_id = $1
       GROUP BY sender
       ORDER BY count DESC`,
      [taskId]
    );

    // 获取时间分布
    const timeDistribution = await pgPool.query(
      `SELECT EXTRACT(HOUR FROM timestamp)::int as hour, COUNT(*) as count
       FROM imported_messages
       WHERE task_id = $1
       GROUP BY hour
       ORDER BY hour`,
      [taskId]
    );

    // 调用 DeepSeek 结构化分析聊天记录
    let analysis = '';
    let profile: Record<string, string> = {};
    let senders: string[] = [];

    // 从 task meta 取预识别的身份 (worker已根据isFromUser判断)
    const metaAiName = task.rows[0]?.meta?.aiName || '';
    const metaUserName = task.rows[0]?.meta?.userName || '';

    try {
      const sample = await pgPool.query(
        `SELECT sender, content FROM imported_messages WHERE task_id=$1 ORDER BY RANDOM() LIMIT 200`,
        [taskId]
      );
      const conversation = sample.rows.map((r: any) => `${r.sender}: ${r.content}`).join('\n');

      senders = [...new Set(sample.rows.map((r: any) => r.sender))];
      const senderList = senders.join('、');

      // 构造身份提示
      const identityHint = metaAiName && metaUserName
        ? `\n重要：根据消息统计，"${metaUserName}" 是用户本人（说话者），"${metaAiName}" 是对话的另一方。请以"${metaAiName}"作为aiName，"${metaUserName}"作为userName。`
        : metaAiName
          ? `\n重要："${metaAiName}" 很可能是对话的另一方（非用户本人），请将其作为aiName。`
          : '';

      const axios = require('axios');
      const fs = require('fs');
      const path = require('path');

      // 读取 ex-skill 分析模板
      const skillPromptsDir = path.resolve('/home/dandelion/.hermes/skills/create-ex/prompts');
      const memoryAnalyzer = fs.readFileSync(path.join(skillPromptsDir, 'memory_analyzer.md'), 'utf-8');
      const memoryBuilder = fs.readFileSync(path.join(skillPromptsDir, 'memory_builder.md'), 'utf-8');
      const personaAnalyzer = fs.readFileSync(path.join(skillPromptsDir, 'persona_analyzer.md'), 'utf-8');
      const personaBuilder = fs.readFileSync(path.join(skillPromptsDir, 'persona_builder.md'), 'utf-8');

      const deepseekConfig = {
        baseURL: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com') + '/v1/chat/completions',
        headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}`, 'Content-Type': 'application/json' },
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      };

      // 并行调用：Part A 记忆分析 + Part B 性格分析
      const [memoryResult, personaResult] = await Promise.all([
        axios.post(deepseekConfig.baseURL, {
          model: deepseekConfig.model,
          messages: [{
            role: 'system',
            content: `${memoryAnalyzer}\n\n${memoryBuilder}\n\n你是关系记忆分析器。根据上述模板，从聊天记录中提取一段完整的 Relationship Memory。直接输出 Markdown，包含：关系概览、时间线、共同记忆、日常模式、争吵档案、甜蜜档案、分手档案。用中文。`
          }, {
            role: 'user',
            content: `对话参与者: ${senderList}。${identityHint}\n\n聊天记录：\n${conversation.substring(0, 12000)}`
          }],
          temperature: 0.7, max_tokens: 2000,
        }, { headers: deepseekConfig.headers, timeout: 120000 }),

        axios.post(deepseekConfig.baseURL, {
          model: deepseekConfig.model,
          messages: [{
            role: 'system',
            content: `${personaAnalyzer}\n\n${personaBuilder}\n\n你是性格行为分析器。根据上述5层模板，从聊天记录中提取一段完整的 Persona。直接输出 Markdown，严格包含5层结构：Layer 0 硬规则、Layer 1 身份、Layer 2 说话风格、Layer 3 情感模式、Layer 4 关系行为。用中文，每层都要有具体行为描述不是抽象标签。`
          }, {
            role: 'user',
            content: `对话参与者: ${senderList}。${identityHint}\n\n聊天记录：\n${conversation.substring(0, 12000)}`
          }],
          temperature: 0.7, max_tokens: 2000,
        }, { headers: deepseekConfig.headers, timeout: 120000 }),
      ]);

      const partA = memoryResult.data?.choices?.[0]?.message?.content || '';
      const partB = personaResult.data?.choices?.[0]?.message?.content || '';

      // 提取基本字段（从 Part B 中解析）
      let partBName = metaAiName || '';
      const nameMatch = partB.match(/名字[：:]\s*(.+)/) || partB.match(/\*\*名字\*\*[：:]\s*(.+)/);
      if (nameMatch) partBName = nameMatch[1].trim();

      analysis = `## PART A：关系记忆\n\n${partA}\n\n---\n\n## PART B：人物性格\n\n${partB}`;
      profile = {
        aiName: partBName || metaAiName || senders[0],
        userName: metaUserName || '',
        partA,
        partB,
      };
    } catch (e: any) { analysis = '分析失败: ' + e.message; }

    // 保存分析结果 (Part A + Part B)
    const resultSummary = JSON.stringify({ partA: profile.partA, partB: profile.partB });
    await pgPool.query(
      `UPDATE import_tasks SET result_summary=$1 WHERE id=$2`,
      [resultSummary, taskId]
    );

    // AI 角色名: Part B 解析 > worker meta > senderStats 推断
    let aiName = profile.aiName || task.rows[0]?.meta?.aiName || '';
    if (!aiName) {
      // 回退: 从 senderStats 分析
      const skipNames = ['', '我', '自己', 'me', 'i', 'self', 'unknown', '未知'];
      const selfPrefixes = ['wxid_', 'user', '用户'];
      if (senderStats.rows.length >= 2) {
        const sorted = [...senderStats.rows].sort((a, b) => a.count - b.count);
        for (const row of sorted) {
          const name = (row.sender || '').trim();
          if (!skipNames.includes(name.toLowerCase()) &&
              !selfPrefixes.some(p => name.toLowerCase().startsWith(p))) {
            aiName = name;
            break;
          }
        }
        if (!aiName) aiName = sorted[0].sender;
      } else if (senderStats.rows.length === 1) {
        aiName = senderStats.rows[0].sender;
      }
    }

    res.json({
      task: task.rows[0],
      analysis,
      profile,       // 结构化分析: { aiName, userName, relationship, personality, ... }
      aiName,
      senderStats: senderStats.rows,
      senders,       // 发送者列表
    });
  } catch (error: any) {
    res.status(500).json({ error: '获取分析失败' });
  }
});

// =============================================================================
// POST /api/import/apply — 将导入的画像应用到 AI 配置
// =============================================================================
router.post('/apply', async (req: Request, res: Response) => {
  try {
    const { taskId, profile } = req.body;  // profile 可包含用户微调后的字段

    if (!taskId) {
      res.status(400).json({ error: '请提供 taskId' });
      return;
    }

    const task = await pgPool.query(
      `SELECT * FROM import_tasks WHERE id = $1 AND user_id = $2 AND status = 'done'`,
      [taskId, req.user!.userId]
    );

    if (task.rows.length === 0) {
      res.status(404).json({ error: '任务不存在或未完成' });
      return;
    }

    // 使用 ex-skill Part A + Part B 格式
    const p = profile || {};
    const partA = p.partA || '';
    const partB = p.partB || '';
    const aiName = p.aiName || '对方';
    const userName = p.userName || '用户';

    const personality = `## PART A：关系记忆\n\n${partA}\n\n---\n\n## PART B：人物性格\n\n${partB}`;

    const customPrompt = [
      `你是"${aiName}"，正在和"${userName}"聊天。`,
      `你不是"${userName}"！你扮演的是${aiName}的角色。`,
      '',
      personality,
      '',
      '## 运行规则',
      '1. 你是' + aiName + '，不是AI助手。用ta的方式说话，用ta的逻辑思考',
      '2. PART B 判断态度：ta会怎么回应？什么语气？',
      '3. PART A 补充记忆：有什么共同经历可以自然融入？',
      '4. 不要写括号动作描写，不要使用emoji',
      '5. 不要跳出角色，不要解释自己是AI',
      '6. Layer 0 硬规则：不说ta在现实中绝不可能说的话',
    ].join('\n');

    const resultSummary = task.rows[0].result_summary;
    const meta = { profile: p, appliedAt: new Date().toISOString() };

    await pgPool.query(
      `INSERT INTO user_profiles (user_id, personality, custom_prompt, import_task_id, model_prefs)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       ON CONFLICT (user_id)
       DO UPDATE SET
         personality = EXCLUDED.personality,
         custom_prompt = EXCLUDED.custom_prompt,
         import_task_id = EXCLUDED.import_task_id,
         model_prefs = EXCLUDED.model_prefs,
         updated_at = NOW()`,
      [req.user!.userId, personality, customPrompt, taskId, JSON.stringify(meta)]
    );

    // 同步到 Hermes：创建 ex-skill persona 并切换
    try {
      const { execSync } = require('child_process');
      const fs = require('fs');
      const path = require('path');
      const slug = 'ex_' + (aiName || 'custom').replace(/[^a-zA-Z0-9一-鿿]/g, '_').toLowerCase().replace(/_+/g, '_').substring(0, 30);

      const skillDir = path.join('/home/dandelion/.hermes/skills/ex-skill', slug);
      fs.mkdirSync(skillDir, { recursive: true });

      const skillMd = [
        '---',
        `name: ${slug}`,
        `description: ${aiName}，${(p.partB || '').substring(0, 60).replace(/\n/g, ' ')}`,
        'user-invocable: true',
        '---',
        '',
        `# ${aiName}`,
        '',
        personality,
        '',
        '## 运行规则',
        `1. 你是${aiName}，不是AI助手。用你的方式说话`,
        '2. PART B 判断态度，PART A 补充记忆',
        '3. 不要跳出角色，不要解释自己是AI',
      ].join('\n');

      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd);
      execSync(`python3 /home/dandelion/.hermes/scripts/persona_manager.py switch ${slug} --keep-memory`, {
        timeout: 15000,
      });
      console.log(`[Import] Hermes已同步创建+切换: ${slug}`);
    } catch (e: any) {
      console.warn(`[Import] Hermes同步跳过: ${e.message}`);
    }

    res.json({ message: 'AI 陪伴配置已更新', personality, customPrompt });
  } catch (error: any) {
    res.status(500).json({ error: '应用失败' });
  }
});

// =============================================================================
// GET /api/import/tasks — 用户的导入历史
// =============================================================================
router.get('/tasks', async (req: Request, res: Response) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = Math.min(parseInt(req.query.limit as string) || 10, 50);
    const offset = (page - 1) * limit;

    const [tasks, countResult] = await Promise.all([
      pgPool.query(
        `SELECT id, filename, format, status, message_count,
                meta, progress, created_at,
                ROW_NUMBER() OVER (ORDER BY created_at DESC) AS seq
         FROM import_tasks
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [req.user!.userId, limit, offset]
      ),
      pgPool.query(
        'SELECT COUNT(*) FROM import_tasks WHERE user_id = $1',
        [req.user!.userId]
      ),
    ]);

    res.json({
      tasks: tasks.rows,
      total: parseInt(countResult.rows[0].count),
      page,
      limit,
    });
  } catch (error: any) {
    res.status(500).json({ error: '获取任务列表失败' });
  }
});

// =============================================================================
// DELETE /api/import/:id — 删除导入任务 (必须在所有具体路由之后)
// =============================================================================
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    await pgPool.query('DELETE FROM imported_messages WHERE task_id=$1', [req.params.id]);
    await pgPool.query('DELETE FROM import_tasks WHERE id=$1 AND user_id=$2', [req.params.id, req.user!.userId]);
    res.json({ message: '已删除' });
  } catch (error: any) { res.status(500).json({ error: '删除失败' }); }
});

/**
 * 递归查找目录中第一个匹配扩展名的文件（解决编码导致的路径不匹配）
 */
function findFileByExt(dir: string, ext: string): string | null {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findFileByExt(full, ext);
      if (found) return found;
    } else if (entry.name.toLowerCase().endsWith(ext.toLowerCase())) {
      return full;
    }
  }
  return null;
}

export default router;

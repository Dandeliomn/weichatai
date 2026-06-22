/**
 * ST Manager API
 *
 * SillyTavern 实例管理与编排路由
 *
 * GET    /api/st/bots/:id/status  → docker inspect container state
 * POST   /api/st/bots/:id/start   → docker compose start {container}
 * POST   /api/st/bots/:id/stop    → docker compose stop {container}
 * POST   /api/st/bots/:id/restart → docker compose restart {container}
 * POST   /api/st/bots/:id/create  → run generate-st-compose.js + docker compose up -d
 */

import { Router, Request, Response } from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';

const execAsync = promisify(exec);

const router = Router();

/** Path to the generated compose file */
const COMPOSE_FILE = path.resolve(__dirname, '..', '..', 'docker-compose.st.yml');

/**
 * Convert a bot_id to the safe container/service name.
 * Same logic as generate-st-compose.js: replace @ and . with -
 */
function botIdToSafe(botId: string): string {
  return botId.replace(/[@.]/g, '-');
}

/** Container name (used with docker inspect, docker start/stop) */
function containerName(botId: string): string {
  return `weclaw-st-${botIdToSafe(botId)}`;
}

/** Compose service name (docker compose commands use service name, not container name) */
function serviceName(botId: string): string {
  return `st-${botIdToSafe(botId)}`;
}

/**
 * Run a docker compose command against the ST compose file.
 * Returns stdout on success, throws on failure.
 */
async function dcCommand(subCmd: string): Promise<string> {
  const { stdout, stderr } = await execAsync(
    `docker compose -f "${COMPOSE_FILE}" ${subCmd}`,
    { timeout: 30_000 }
  );
  if (stderr) console.warn(`[ST-Manager] stderr: ${stderr.trim()}`);
  return stdout.trim();
}

/**
 * Run a docker inspect command for a specific container.
 */
async function dcInspect(container: string): Promise<any> {
  const { stdout, stderr } = await execAsync(
    `docker inspect ${container}`,
    { timeout: 10_000 }
  );
  if (stderr) console.warn(`[ST-Manager] inspect stderr: ${stderr.trim()}`);
  return JSON.parse(stdout);
}

// =============================================================================
// 路由定义
// =============================================================================

/**
 * GET /api/st/bots/:id/status
 * 查询指定 ST 容器的运行状态
 */
router.get('/bots/:id/status', async (req: Request, res: Response) => {
  try {
    const botId = String(req.params.id);
    const cName = containerName(botId);

    const data = await dcInspect(cName);

    if (!Array.isArray(data) || data.length === 0) {
      res.json({
        ok: true,
        running: false,
        state: { Status: 'not_found' },
      });
      return;
    }

    const state = data[0].State || {};
    const config = data[0].Config || {};
    const networkSettings = data[0].NetworkSettings || {};

    res.json({
      ok: true,
      running: state.Running === true,
      state: {
        Status: state.Status || 'unknown',
        Running: state.Running,
        StartedAt: state.StartedAt || null,
        FinishedAt: state.FinishedAt || null,
        ExitCode: state.ExitCode ?? null,
        Health: state.Health || null,
      },
      image: config.Image || null,
      ports: networkSettings.Ports || null,
      containerName: cName,
    });
  } catch (err: any) {
    // docker inspect returns exit code 1 for non-existent containers
    if (err.message && (err.message.includes('No such object') || err.message.includes('Error: No such'))) {
      res.json({
        ok: true,
        running: false,
        state: { Status: 'not_found' },
      });
      return;
    }
    console.error(`[ST-Manager] status error for ${req.params.id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/st/bots/:id/start
 * 启动指定 ST 容器
 */
router.post('/bots/:id/start', async (req: Request, res: Response) => {
  try {
    const sName = serviceName(String(req.params.id));
    const output = await dcCommand(`start ${sName}`);
    console.log(`[ST-Manager] ✅ Started ${sName}`);
    res.json({ ok: true, message: `Service ${sName} started`, output });
  } catch (err: any) {
    console.error(`[ST-Manager] start error for ${req.params.id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/st/bots/:id/stop
 * 停止指定 ST 容器
 */
router.post('/bots/:id/stop', async (req: Request, res: Response) => {
  try {
    const sName = serviceName(String(req.params.id));
    const output = await dcCommand(`stop ${sName}`);
    console.log(`[ST-Manager] ✅ Stopped ${sName}`);
    res.json({ ok: true, message: `Service ${sName} stopped`, output });
  } catch (err: any) {
    console.error(`[ST-Manager] stop error for ${req.params.id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/st/bots/:id/restart
 * 重启指定 ST 容器
 */
router.post('/bots/:id/restart', async (req: Request, res: Response) => {
  try {
    const sName = serviceName(String(req.params.id));
    const output = await dcCommand(`restart ${sName}`);
    console.log(`[ST-Manager] ✅ Restarted ${sName}`);
    res.json({ ok: true, message: `Service ${sName} restarted`, output });
  } catch (err: any) {
    console.error(`[ST-Manager] restart error for ${req.params.id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * POST /api/st/bots/:id/create
 * 为新 Bot 创建 ST 实例:
 *   1. 运行 generate-st-compose.js 重新生成 compose 文件
 *   2. docker compose up -d 启动新容器
 *
 * Note: creates/recreates all services defined in the compose file.
 * Docker's compose up -d is idempotent — existing containers are left alone,
 * new ones are created.
 */
router.post('/bots/:id/create', async (req: Request, res: Response) => {
  try {
    const botId = String(req.params.id);
    const cName = containerName(botId);

    // Step 1: Regenerate compose file
    const scriptPath = path.resolve(__dirname, '..', '..', 'scripts', 'generate-st-compose.js');
    const { stdout: genOut, stderr: genErr } = await execAsync(
      `node ${scriptPath}`,
      { timeout: 15_000 }
    );
    if (genErr && !genErr.includes('Deprecation')) {
      console.warn(`[ST-Manager] generate-st-compose stderr:`, genErr.trim());
    }
    console.log(`[ST-Manager] Compose regenerated:`, genOut.trim());

    // Step 2: docker compose up -d
    const upOutput = await dcCommand('up -d');
    console.log(`[ST-Manager] ✅ Created ${cName}`);

    res.json({
      ok: true,
      message: `Container ${cName} created/updated`,
      containerName: cName,
      composeOutput: genOut.trim(),
      upOutput,
    });
  } catch (err: any) {
    console.error(`[ST-Manager] create error for ${req.params.id}:`, err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

export default router;

/**
 * 角色人格参数 API — 共享数据层
 *
 * GET  /api/persona/current  — 读取 active_persona.json
 * POST /api/persona/update   — 写入 parameters + catchphrases
 *
 * 数据文件: ~/.hermes/active_persona.json
 * Plan A (微信) 和 Plan B (仪表盘) 共享此 JSON
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { authenticate } from '../middleware/auth.js';

const PERSONA_PATH = process.env.PERSONA_PATH ||
  path.join(os.homedir(), '.hermes', 'active_persona.json');

const DEFAULT_PARAMETERS = {
  talkativeness: 0.5,
  warmth: 0.5,
  reply_length: 0.5,
  playfulness: 0.5,
  patience: 0.5,
  affection: 0.5,
};

function readPersona() {
  if (!fs.existsSync(PERSONA_PATH)) {
    return {
      attributes: [],
      parameters: { ...DEFAULT_PARAMETERS },
      catchphrases: [],
      updated_by: 'system',
      updated_at: new Date().toISOString(),
    };
  }

  const raw = fs.readFileSync(PERSONA_PATH, 'utf8');
  const data = JSON.parse(raw);

  // Ensure parameters exist (backward compat)
  if (!data.parameters) {
    data.parameters = { ...DEFAULT_PARAMETERS };
  }
  // Fill missing keys with defaults
  for (const [key, val] of Object.entries(DEFAULT_PARAMETERS)) {
    if (data.parameters[key] == null) {
      data.parameters[key] = val;
    }
  }
  // Ensure catchphrases exists
  if (!Array.isArray(data.catchphrases)) {
    data.catchphrases = [];
  }

  return data;
}

function writePersona(data: any) {
  const dir = path.dirname(PERSONA_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(PERSONA_PATH, JSON.stringify(data, null, 2), 'utf8');
}

export default function initPersonaRoutes(): Router {
  const router = Router();

  // GET /api/persona/current
  router.get('/current', authenticate, (_req: Request, res: Response) => {
    try {
      const data = readPersona();
      res.json(data);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/persona/update
  router.post('/update', authenticate, (req: Request, res: Response) => {
    try {
      const { parameters, catchphrases } = req.body;

      // Read current (preserves attributes, etc.)
      const data = readPersona();

      // Update parameters
      if (parameters && typeof parameters === 'object') {
        for (const [key, val] of Object.entries(parameters)) {
          if (key in DEFAULT_PARAMETERS) {
            data.parameters[key] = Math.round(Math.min(1, Math.max(0, Number(val))) * 10) / 10;
          }
        }
      }

      // Update catchphrases
      if (Array.isArray(catchphrases)) {
        data.catchphrases = catchphrases.filter(
          (c: any) => typeof c === 'string' && c.trim().length > 0
        );
      }

      data.updated_by = 'dashboard';
      data.updated_at = new Date().toISOString();

      writePersona(data);

      res.json({ ok: true, parameters: data.parameters, catchphrases: data.catchphrases });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}

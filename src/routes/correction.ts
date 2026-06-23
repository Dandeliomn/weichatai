/**
 * 记忆自进化 + 关系分析 API
 *
 * POST /api/memory/correct      — 触发记忆纠正
 * POST /api/memory/analyze      — 触发关系分析
 * GET  /api/memory/corrections  — 查看纠正历史
 */

import { Router, Request, Response } from 'express';
import { spawn } from 'child_process';
import path from 'path';
import { Pool } from 'pg';

export default function initCorrectionRoutes(pgPool: Pool): Router {
const router = Router();

// POST /api/memory/correct
router.post('/correct', async (req: Request, res: Response) => {
  try {
    const { character, claim } = req.body;
    if (!character || !claim) {
      return res.status(400).json({ error: 'character and claim required' });
    }

    const child = spawn('node', [
      path.join(__dirname, '..', '..', 'scripts', 'memory-correct.js'),
      '-c', character,
      '-m', claim,
    ], { cwd: path.join(__dirname, '..', '..') });

    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { output += d.toString(); });

    child.on('close', (code: number) => {
      const success = output.includes('✅ 更正完成');
      res.json({
        success,
        exitCode: code,
        output: output.substring(0, 1000),
      });
    });

    child.on('error', (err: Error) => {
      res.status(500).json({ error: err.message });
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/memory/analyze
router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const { character } = req.body;
    if (!character) {
      return res.status(400).json({ error: 'character required' });
    }

    const child = spawn('node', [
      path.join(__dirname, '..', '..', 'scripts', 'love-analysis.js'),
      '-c', character,
    ], { cwd: path.join(__dirname, '..', '..') });

    let output = '';
    child.stdout.on('data', (d: Buffer) => { output += d.toString(); });

    child.on('close', (code: number) => {
      res.json({
        success: code === 0,
        promptLength: output.length,
        prompt: output.substring(0, 8000), // Truncated for API
      });
    });

    child.on('error', (err: Error) => {
      res.status(500).json({ error: err.message });
    });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/memory/corrections
router.get('/corrections', async (_req: Request, res: Response) => {
  try {
    const result = await pgPool.query(
      `SELECT id, character_name, claim, confidence, status, created_at
       FROM correction_logs ORDER BY created_at DESC LIMIT 50`
    );
    res.json({ corrections: result.rows });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

  return router;
}

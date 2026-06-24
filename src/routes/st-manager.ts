import { Router } from 'express';
const router = Router();
router.get('/status', (_req, res) => {
  res.json({ ok: true, message: 'ST manager stub' });
});
export default router;

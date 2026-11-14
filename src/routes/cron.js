// Endpoints for a scheduler (Vercel Cron, or any external pinger). Protected by CRON_SECRET,
// which Vercel sends automatically as `Authorization: Bearer <CRON_SECRET>`.
import crypto from 'node:crypto';
import { Router } from 'express';
import { config } from '../config.js';
import { runAll, retention, overlapCheck } from '../jobs.js';
import { ApiError } from '../errors.js';

export const router = Router();

router.use((req, _res, next) => {
  if (!config.cronSecret) throw new ApiError(404, 'NOT_FOUND', 'Not found'); // disabled until a secret is set
  const got = Buffer.from((req.headers.authorization || '').replace(/^Bearer /i, ''));
  const want = Buffer.from(config.cronSecret);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) throw new ApiError(401, 'UNAUTHENTICATED', 'Bad cron secret');
  next();
});

/** Every-minute work: no-shows, completion, downtime notices, outbox. */
router.get('/tick', async (_req, res) => res.json(await runAll()));

/** Daily: the same sweeps, plus retention and the overlap check that must return no rows. */
router.get('/daily', async (_req, res) => {
  const sweeps = await runAll();
  const overlaps = await overlapCheck();
  const kept = await retention();
  if (overlaps.length) console.error('OVERLAP CHECK FAILED', JSON.stringify(overlaps));
  res.status(overlaps.length ? 500 : 200).json({ sweeps, retention: kept, overlap_rows: overlaps.length });
});

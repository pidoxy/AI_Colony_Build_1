import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ApiError, isConnectionError } from './errors.js';
import { router as student } from './routes/student.js';
import { router as admin } from './routes/admin.js';
import { primaryUp } from './db.js';
import { router as cron } from './routes/cron.js';
import { config } from './config.js';
import { maybeSweep } from './jobs.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  app.use((_req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });

  app.get('/health', async (_req, res) => res.json({ ok: true, primary: await primaryUp() }));
  app.use(express.static(path.join(here, '..', 'public'), { extensions: ['html'] }));
  app.use('/cron', cron);
  if (config.sweepOnRequest) {
    app.use(['/rooms', '/me', '/bookings', '/session', '/announcements'], async (_req, _res, next) => { await maybeSweep(); next(); });
  }
  app.use('/admin', admin);
  app.use('/', student);

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: `No such route: ${req.method} ${req.path}` } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Request body is not valid JSON' } });
    }
    if (isConnectionError(err)) {
      return res.status(503).json({ error: { code: 'SERVICE_UNAVAILABLE', message: 'Service unavailable. Try again in a few minutes.' } });
    }
    console.error('[api] unhandled', req.method, req.path, err);
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });
  return app;
}

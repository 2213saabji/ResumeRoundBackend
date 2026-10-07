import { Router } from 'express';
import { config } from './config.js';
import { isDbReady } from './db.js';
import { JanusClient } from '../modules/media/janus-client.js';

export const healthRouter = Router();

/** Liveness: the process is up. Never checks dependencies (a DB blip must not restart every pod). */
healthRouter.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/** Readiness: dependencies needed to serve traffic are reachable. */
healthRouter.get('/readyz', async (_req, res) => {
  const checks: Record<string, 'ok' | 'fail' | 'skipped'> = {
    mongodb: isDbReady() ? 'ok' : 'fail',
    janus: 'skipped',
  };
  if (config.JANUS_HTTP_URL) {
    checks.janus = await new JanusClient(config.JANUS_HTTP_URL)
      .info()
      .then(() => 'ok' as const)
      .catch(() => 'fail' as const);
  }
  const ready = Object.values(checks).every((c) => c !== 'fail');
  res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not_ready', checks });
});

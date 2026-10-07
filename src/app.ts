import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { pinoHttp } from 'pino-http';
import { config } from './common/config.js';
import { healthRouter } from './common/health.js';
import { logger } from './common/logger.js';
import { errorHandler, notFoundHandler } from './common/middleware/error-handler.js';
import { requestId } from './common/middleware/request-id.js';
import { apiRouter } from './routes.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  // Behind exactly one proxy (load balancer); makes req.ip the real client IP for rate limits.
  app.set('trust proxy', 1);

  // 1. Security, CORS, compression, body limits (multipart uploads are handled by multer per route).
  app.use(helmet());
  app.use(
    cors({
      origin: config.CORS_ORIGINS,
      credentials: true,
      exposedHeaders: ['X-Request-Id', 'Location', 'Retry-After', 'RateLimit-Remaining'],
    }),
  );
  app.use(compression());
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  // 2. Request id + structured request logs.
  app.use(requestId);
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).requestId,
      autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' },
      customProps: (req) => ({ userId: (req as express.Request).user?.id }),
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({
          id: req.id,
          method: req.method,
          url: req.url,
        }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );

  app.use(healthRouter);
  // 3-6. Rate limiting, authentication, validation and controllers are applied per route.
  app.use('/api/v1', apiRouter);

  // 7. Central error handling.
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

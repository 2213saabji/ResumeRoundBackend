import { pino } from 'pino';
import { config, isProd } from './config.js';

export const logger = pino({
  level: config.LOG_LEVEL,
  base: { env: config.NODE_ENV },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.passwordHash',
      '*.refreshToken',
      '*.rawText',
    ],
    censor: '[redacted]',
  },
  transport:
    !isProd && config.NODE_ENV !== 'test'
      ? {
          target: 'pino-pretty',
          options: { translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,env' },
        }
      : undefined,
});

export type Logger = typeof logger;

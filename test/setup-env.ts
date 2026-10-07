import os from 'node:os';
import path from 'node:path';

// Runs before any test module imports src/common/config.ts. Point dotenv at a file that does
// not exist so a developer's .env (and its real database) can never leak into tests.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: path.join(os.tmpdir(), 'resumeround-no-dotenv'),
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  MONGODB_URI: 'mongodb://set-per-test-file',
  JWT_ACCESS_SECRET: 'test-secret-test-secret-test-secret-0123456789',
  AI_PROVIDER: 'mock',
  STORAGE_DRIVER: 'local',
  LOCAL_STORAGE_DIR: path.join(os.tmpdir(), 'resumeround-test-storage'),
  CORS_ORIGINS: 'http://localhost:3000',
  FREE_INTERVIEWS_PER_MONTH: '3',
});

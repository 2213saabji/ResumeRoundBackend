/**
 * PM2 process file: one build (dist/), three processes. No Docker at launch.
 *   npm ci && npm run build && npm run db:sync-indexes
 *   pm2 start ecosystem.config.cjs --env production && pm2 save
 * Environment comes from the VM (or a .env next to this file); never commit secrets here.
 */
module.exports = {
  apps: [
    {
      name: 'rr-api',
      script: 'dist/apps/api.js',
      // Stateless: one process per vCPU behind PM2's cluster balancer.
      exec_mode: 'cluster',
      instances: 2,
      max_memory_restart: '512M',
      kill_timeout: 15000,
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'rr-worker',
      script: 'dist/apps/worker.js',
      instances: 1,
      max_memory_restart: '768M',
      // Lets in-flight jobs finish (worker shutdown waits up to 60s).
      kill_timeout: 65000,
      env_production: { NODE_ENV: 'production' },
    },
    {
      name: 'rr-bot',
      script: 'dist/apps/bot.js',
      // Each bot owns its live interviews in memory: scale by adding bots, never cluster mode.
      instances: 1,
      max_memory_restart: '1G',
      kill_timeout: 15000,
      env_production: { NODE_ENV: 'production' },
    },
  ],
};

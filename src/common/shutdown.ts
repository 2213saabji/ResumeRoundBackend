import { logger } from './logger.js';

/**
 * Runs `cleanup` once on SIGTERM/SIGINT (PM2 sends SIGINT on reload), then exits.
 * A hard timeout guarantees the process exits even if cleanup hangs.
 */
export function onShutdown(cleanup: () => Promise<void>, timeoutMs = 15_000): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => {
      logger.error('shutdown timed out, forcing exit');
      process.exit(1);
    }, timeoutMs);
    timer.unref();
    cleanup()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        logger.error({ err }, 'error during shutdown');
        process.exit(1);
      });
  };
  process.on('SIGTERM', handler);
  process.on('SIGINT', handler);
  process.on('unhandledRejection', (reason) =>
    logger.error({ err: reason }, 'unhandled promise rejection'),
  );
}

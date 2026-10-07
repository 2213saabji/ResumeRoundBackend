import { createApp } from '../app.js';
import { config } from '../common/config.js';
import { connectDb, disconnectDb } from '../common/db.js';
import { logger } from '../common/logger.js';
import { onShutdown } from '../common/shutdown.js';

await connectDb(config.MONGODB_URI);

const server = createApp().listen(config.PORT, () => {
  logger.info({ port: config.PORT }, 'api listening');
});
// Must exceed the load balancer's idle timeout to avoid 502s on reused connections.
server.keepAliveTimeout = 65_000;

onShutdown(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
  await disconnectDb();
});

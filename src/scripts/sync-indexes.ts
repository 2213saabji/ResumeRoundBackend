/**
 * Creates/updates every index declared on the Mongoose models. Production boots with
 * autoIndex off, so run this on deploy: `npm run db:sync-indexes`.
 * Atlas Vector Search indexes are managed separately (docs/atlas-vector-search.md).
 */
import mongoose from 'mongoose';
import { config } from '../common/config.js';
import { connectDb, disconnectDb } from '../common/db.js';
import { logger } from '../common/logger.js';

// Importing the app registers every model.
await import('../app.js');
await import('../modules/ai/cost-meter.js');
await import('../modules/jobs/model.js');
await import('../modules/media/bot-registry.js');
await import('../modules/questions/model.js');

await connectDb(config.MONGODB_URI);
try {
  for (const name of mongoose.modelNames()) {
    const dropped = await mongoose.model(name).syncIndexes();
    logger.info({ model: name, dropped }, 'indexes synced');
  }
} finally {
  await disconnectDb();
}

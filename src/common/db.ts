import mongoose from 'mongoose';
import { isProd } from './config.js';
import { logger } from './logger.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri: string, options: { dbName?: string } = {}): Promise<void> {
  await mongoose.connect(uri, {
    dbName: options.dbName,
    // Indexes are created by `npm run db:sync-indexes` in production, never at boot.
    autoIndex: !isProd,
    serverSelectionTimeoutMS: 10_000,
    maxPoolSize: 20,
  });
  logger.info({ db: mongoose.connection.name }, 'mongodb connected');
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

export function isDbReady(): boolean {
  return mongoose.connection.readyState === mongoose.ConnectionStates.connected;
}

/** Runs `fn` inside a MongoDB transaction (requires a replica set, which Atlas always is). */
export async function withTransaction<T>(
  fn: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    return await session.withTransaction(fn);
  } finally {
    await session.endSession();
  }
}

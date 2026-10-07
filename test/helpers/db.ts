import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { afterAll, beforeAll, inject } from 'vitest';
import { connectDb, disconnectDb } from '../../src/common/db.js';

/** Connects this test file to its own fresh database and builds every model's indexes. */
export function useTestDb(): void {
  beforeAll(async () => {
    await connectDb(inject('mongoUri'), { dbName: `test_${randomUUID().slice(0, 8)}` });
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectDb();
  });
}

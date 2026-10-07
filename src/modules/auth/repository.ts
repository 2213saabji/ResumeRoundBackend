import { RefreshSessionModel, type RefreshSession } from './model.js';

export const refreshSessionsRepository = {
  async create(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string;
    ip?: string;
  }): Promise<RefreshSession> {
    const doc = await RefreshSessionModel.create(data);
    return doc.toObject<RefreshSession>();
  },

  /** Atomically swaps the token hash; returns null if the presented hash is stale or expired. */
  rotate(
    sessionId: string,
    currentHash: string,
    nextHash: string,
    expiresAt: Date,
  ): Promise<RefreshSession | null> {
    const now = new Date();
    return RefreshSessionModel.findOneAndUpdate(
      { _id: sessionId, tokenHash: currentHash, expiresAt: { $gt: now } },
      { $set: { tokenHash: nextHash, expiresAt, lastUsedAt: now } },
      { returnDocument: 'after' },
    ).lean<RefreshSession>();
  },

  async deleteById(sessionId: string): Promise<void> {
    await RefreshSessionModel.deleteOne({ _id: sessionId });
  },

  async deleteByIdAndHash(sessionId: string, tokenHash: string): Promise<void> {
    await RefreshSessionModel.deleteOne({ _id: sessionId, tokenHash });
  },
};

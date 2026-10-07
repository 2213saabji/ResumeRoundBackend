import type { ClientSession } from 'mongoose';
import { JobModel, type Job, type JobPayloads, type JobType } from './model.js';

/** Thrown by a handler when retrying cannot help (bad input, missing document, ...). */
export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetryableError';
  }
}

const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Exponential backoff: 2s, 4s, 8s, ... capped at 5 min, with ±20% jitter. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempt);
  return Math.round(base * (0.8 + random() * 0.4));
}

export const jobQueue = {
  async enqueue<T extends JobType>(
    type: T,
    payload: JobPayloads[T],
    opts: { runAt?: Date; maxAttempts?: number; session?: ClientSession } = {},
  ): Promise<Job> {
    const [doc] = await JobModel.create(
      [{ type, payload, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 5 }],
      { session: opts.session },
    );
    return doc!.toObject<Job>();
  },

  /** Atomically claims the oldest due job of the given types (findOneAndUpdate is the lock). */
  claim(workerId: string, types: readonly string[], lockMs: number): Promise<Job | null> {
    const now = new Date();
    return JobModel.findOneAndUpdate(
      {
        type: { $in: types },
        $or: [
          { status: 'queued', runAt: { $lte: now } },
          { status: 'running', lockedUntil: { $lt: now } },
        ],
      },
      {
        $set: {
          status: 'running',
          lockedBy: workerId,
          lockedUntil: new Date(now.getTime() + lockMs),
        },
        $inc: { attempts: 1 },
      },
      { sort: { runAt: 1 }, returnDocument: 'after' },
    ).lean<Job>();
  },

  async extendLock(jobId: JobId, workerId: string, lockMs: number): Promise<boolean> {
    const res = await JobModel.updateOne(
      { _id: jobId, status: 'running', lockedBy: workerId },
      { $set: { lockedUntil: new Date(Date.now() + lockMs) } },
    );
    return res.modifiedCount === 1;
  },

  async complete(jobId: JobId, workerId: string): Promise<void> {
    await JobModel.updateOne(
      { _id: jobId, status: 'running', lockedBy: workerId },
      {
        $set: { status: 'succeeded', completedAt: new Date() },
        $unset: { lockedBy: 1, lockedUntil: 1 },
      },
    );
  },

  /** Requeues with backoff, or dead-letters once attempts are exhausted or the error is permanent. */
  async fail(job: Job, workerId: string, err: unknown): Promise<'retry' | 'dead'> {
    const message = err instanceof Error ? err.message : String(err);
    const dead = err instanceof NonRetryableError || job.attempts >= job.maxAttempts;
    await JobModel.updateOne(
      { _id: job._id, status: 'running', lockedBy: workerId },
      dead
        ? {
            $set: { status: 'dead', lastError: message, completedAt: new Date() },
            $unset: { lockedBy: 1, lockedUntil: 1 },
          }
        : {
            $set: {
              status: 'queued',
              lastError: message,
              runAt: new Date(Date.now() + backoffMs(job.attempts)),
            },
            $unset: { lockedBy: 1, lockedUntil: 1 },
          },
    );
    return dead ? 'dead' : 'retry';
  },
};

type JobId = Job['_id'];

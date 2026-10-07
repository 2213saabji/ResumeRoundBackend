import type { RequestHandler } from 'express';
import { Schema, model } from 'mongoose';
import { Errors } from '../errors.js';

/**
 * Fixed-window rate limiter on a MongoDB TTL collection (replaces Redis INCR/EXPIRE).
 * One document per key per window; MongoDB's TTL monitor deletes expired windows.
 */
const rateLimitSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    count: { type: Number, required: true, default: 0 },
    windowStart: { type: Date, required: true },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'rate_limits' },
);
rateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimitModel = model('RateLimit', rateLimitSchema);

function isDuplicateKey(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000;
}

export async function hitRateLimit(
  key: string,
  windowMs: number,
  now = Date.now(),
): Promise<{ count: number; resetAt: number }> {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  const resetAt = windowStart + windowMs;
  const filter = { key: `${key}:${windowStart}` };
  const update = {
    $inc: { count: 1 },
    $setOnInsert: { windowStart: new Date(windowStart), expiresAt: new Date(resetAt) },
  };
  try {
    const doc = await RateLimitModel.findOneAndUpdate(filter, update, {
      upsert: true,
      returnDocument: 'after',
    }).lean();
    return { count: doc!.count, resetAt };
  } catch (err) {
    // Two concurrent upserts on a fresh window: one wins the insert, the other retries as an update.
    if (!isDuplicateKey(err)) throw err;
    const doc = await RateLimitModel.findOneAndUpdate(filter, update, {
      returnDocument: 'after',
    }).lean();
    return { count: doc!.count, resetAt };
  }
}

interface RateLimitOptions {
  /** Bucket name, e.g. 'auth' or 'resume-upload'. */
  name: string;
  windowMs: number;
  max: number;
  /** 'user' falls back to IP for unauthenticated requests. */
  keyBy?: 'ip' | 'user';
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  return async (req, res, next) => {
    const identity = opts.keyBy === 'user' && req.user ? `u:${req.user.id}` : `ip:${req.ip}`;
    const { count, resetAt } = await hitRateLimit(`${opts.name}:${identity}`, opts.windowMs);
    const remaining = Math.max(0, opts.max - count);
    res.setHeader('RateLimit-Limit', String(opts.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil((resetAt - Date.now()) / 1000)));
    if (count > opts.max) {
      return next(Errors.rateLimited(Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))));
    }
    next();
  };
}

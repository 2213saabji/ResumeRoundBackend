import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';
import { Schema, model } from 'mongoose';
import { AppError, Errors } from '../errors.js';
import { logger } from '../logger.js';

const TTL_MS = 24 * 60 * 60 * 1000;

const idempotencySchema = new Schema(
  {
    userId: { type: String, required: true },
    key: { type: String, required: true },
    route: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed'], required: true },
    responseStatus: Number,
    responseBody: Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false, collection: 'idempotency_keys' },
);
idempotencySchema.index({ userId: 1, route: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const IdempotencyKeyModel = model('IdempotencyKey', idempotencySchema);

const VALID_KEY = /^[A-Za-z0-9_-]{8,128}$/;

function hashRequest(body: unknown, file?: Express.Multer.File): string {
  const h = createHash('sha256').update(JSON.stringify(body ?? null));
  if (file) h.update(file.buffer);
  return h.digest('hex');
}

/**
 * Honours an optional `Idempotency-Key` header on POSTs that create resources.
 * Must run after `authenticate` (keys are scoped per user) and after any body/multipart parser.
 * A retried request with the same key and payload replays the stored response.
 */
export const idempotency: RequestHandler = async (req, res, next) => {
  const key = req.header('idempotency-key');
  if (!key) return next();
  if (!VALID_KEY.test(key)) return next(Errors.badRequest('Invalid Idempotency-Key header'));
  if (!req.user) return next(Errors.unauthorized());

  const route = `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;
  const requestHash = hashRequest(req.body, req.file);
  const scope = { userId: req.user.id, route, key };

  try {
    await IdempotencyKeyModel.create({
      ...scope,
      requestHash,
      state: 'in_progress',
      expiresAt: new Date(Date.now() + TTL_MS),
    });
  } catch (err) {
    if ((err as { code?: number }).code !== 11000) throw err;
    const existing = await IdempotencyKeyModel.findOne(scope).lean();
    if (!existing) return next(Errors.conflict('Idempotent request state changed, retry'));
    if (existing.requestHash !== requestHash) {
      return next(
        new AppError(
          422,
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key reused with a different payload',
        ),
      );
    }
    if (existing.state === 'in_progress') {
      return next(
        new AppError(
          409,
          'IDEMPOTENCY_CONFLICT',
          'A request with this Idempotency-Key is in progress',
        ),
      );
    }
    res.setHeader('Idempotent-Replayed', 'true');
    return res.status(existing.responseStatus ?? 200).json(existing.responseBody);
  }

  let captured: unknown;
  const originalJson = res.json.bind(res);
  res.json = (body: unknown) => {
    captured = body;
    return originalJson(body);
  };

  res.on('finish', () => {
    // Failed requests release the key so the client can retry; successes are stored for replay.
    const op =
      res.statusCode >= 400
        ? IdempotencyKeyModel.deleteOne(scope)
        : IdempotencyKeyModel.updateOne(scope, {
            $set: { state: 'completed', responseStatus: res.statusCode, responseBody: captured },
          });
    op.catch((err: unknown) => logger.error({ err }, 'failed to persist idempotency result'));
  });

  next();
};

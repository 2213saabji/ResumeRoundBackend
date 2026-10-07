import type { ErrorRequestHandler, RequestHandler } from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import { ZodError } from 'zod';
import { AppError, Errors } from '../errors.js';
import { logger } from '../logger.js';

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(Errors.notFound(`Route ${req.method} ${req.path}`));
};

function normalize(err: unknown): AppError {
  if (err instanceof AppError) return err;
  if (err instanceof ZodError) {
    return Errors.validation(
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  if (err instanceof multer.MulterError) {
    return err.code === 'LIMIT_FILE_SIZE'
      ? Errors.payloadTooLarge('File exceeds the 5 MB limit')
      : Errors.badRequest(err.message);
  }
  if (err instanceof mongoose.Error.CastError) return Errors.badRequest(`Invalid ${err.path}`);
  if (err instanceof mongoose.Error.ValidationError) {
    return Errors.validation(
      Object.values(err.errors).map((e) => ({ path: e.path, message: e.message })),
    );
  }
  if (typeof err === 'object' && err !== null) {
    const e = err as { code?: unknown; type?: unknown };
    if (e.code === 11000) return Errors.conflict('Resource already exists');
    // body-parser errors
    if (e.type === 'entity.parse.failed') return Errors.badRequest('Malformed JSON body');
    if (e.type === 'entity.too.large') return Errors.payloadTooLarge();
  }
  return new AppError(500, 'INTERNAL', 'Internal server error');
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const appErr = normalize(err);
  if (appErr.status >= 500) {
    (req.log ?? logger).error({ err }, 'unhandled error');
  }
  if (appErr.code === 'RATE_LIMITED') {
    const retry = (appErr.details as { retryAfterSec?: number } | undefined)?.retryAfterSec;
    if (retry) res.setHeader('Retry-After', String(retry));
  }
  res.status(appErr.status).json({
    error: {
      code: appErr.code,
      message: appErr.message,
      details: appErr.details,
      requestId: req.requestId,
    },
  });
};

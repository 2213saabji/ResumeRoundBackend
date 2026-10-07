export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'QUOTA_EXCEEDED'
  | 'RATE_LIMITED'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE'
  | 'NOT_IMPLEMENTED'
  | 'SERVICE_UNAVAILABLE'
  | 'INTERNAL';

export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  badRequest: (message = 'Bad request', details?: unknown) =>
    new AppError(400, 'BAD_REQUEST', message, details),
  validation: (details: unknown) =>
    new AppError(400, 'VALIDATION_ERROR', 'Request validation failed', details),
  unauthorized: (message = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', message),
  forbidden: (message = 'Forbidden') => new AppError(403, 'FORBIDDEN', message),
  notFound: (resource = 'Resource') => new AppError(404, 'NOT_FOUND', `${resource} not found`),
  conflict: (message: string, details?: unknown) => new AppError(409, 'CONFLICT', message, details),
  quotaExceeded: (message: string) => new AppError(403, 'QUOTA_EXCEEDED', message),
  rateLimited: (retryAfterSec: number) =>
    new AppError(429, 'RATE_LIMITED', 'Too many requests', { retryAfterSec }),
  payloadTooLarge: (message = 'Payload too large') =>
    new AppError(413, 'PAYLOAD_TOO_LARGE', message),
  unsupportedMediaType: (message: string) => new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', message),
  notImplemented: (feature: string) =>
    new AppError(501, 'NOT_IMPLEMENTED', `${feature} is not implemented yet`),
  unavailable: (message: string) => new AppError(503, 'SERVICE_UNAVAILABLE', message),
};

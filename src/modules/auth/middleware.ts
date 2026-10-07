import type { Request, RequestHandler } from 'express';
import { Errors } from '../../common/errors.js';
import type { UserRole } from '../users/model.js';
import { verifyAccessToken, type AuthUser } from './tokens.js';

export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.header('authorization');
  const [scheme, token] = header?.split(' ') ?? [];
  if (scheme?.toLowerCase() !== 'bearer' || !token) return next(Errors.unauthorized());
  req.user = verifyAccessToken(token);
  next();
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(Errors.unauthorized());
    if (!roles.includes(req.user.role)) return next(Errors.forbidden());
    next();
  };
}

/** For controllers behind `authenticate`: returns the user or throws 401. */
export function requireUser(req: Request): AuthUser {
  if (!req.user) throw Errors.unauthorized();
  return req.user;
}

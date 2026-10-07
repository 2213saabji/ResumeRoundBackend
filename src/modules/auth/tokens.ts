import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { config } from '../../common/config.js';
import { Errors } from '../../common/errors.js';
import { USER_ROLES, type UserRole } from '../users/model.js';

export interface AuthUser {
  id: string;
  role: UserRole;
}

const ISSUER = 'resumeround';
const AUDIENCE = 'resumeround-api';

export function signAccessToken(user: AuthUser): string {
  return jwt.sign({ role: user.role }, config.JWT_ACCESS_SECRET, {
    subject: user.id,
    expiresIn: config.JWT_ACCESS_TTL_SECONDS,
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verifyAccessToken(token: string): AuthUser {
  try {
    const payload = jwt.verify(token, config.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof payload === 'string' || !payload.sub) throw new Error('malformed token');
    const role = (payload as { role?: unknown }).role;
    if (!USER_ROLES.includes(role as UserRole)) throw new Error('malformed role');
    return { id: payload.sub, role: role as UserRole };
  } catch {
    throw Errors.unauthorized('Invalid or expired access token');
  }
}

/** Refresh tokens are `<sessionId>.<secret>`; only sha256(secret) is stored. */
export function newRefreshSecret(): string {
  return randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

export function formatRefreshToken(sessionId: string, secret: string): string {
  return `${sessionId}.${secret}`;
}

export function parseRefreshToken(token: string): { sessionId: string; secret: string } | null {
  const [sessionId, secret, ...rest] = token.split('.');
  if (rest.length || !sessionId || !secret || !Types.ObjectId.isValid(sessionId)) return null;
  return { sessionId, secret };
}

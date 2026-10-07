import { hash, verify } from '@node-rs/argon2';
import { OAuth2Client } from 'google-auth-library';
import { config } from '../../common/config.js';
import { Errors } from '../../common/errors.js';
import type { User } from '../users/model.js';
import { usersRepository } from '../users/repository.js';
import { toPublicUser, type PublicUser } from '../users/service.js';
import { refreshSessionsRepository } from './repository.js';
import type { GoogleLoginInput, LoginInput, RegisterInput } from './schemas.js';
import {
  formatRefreshToken,
  hashSecret,
  newRefreshSecret,
  parseRefreshToken,
  signAccessToken,
} from './tokens.js';

// OWASP-recommended argon2id parameters (argon2id is the library default algorithm).
const ARGON2_OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

// Verified against when the email is unknown, so login timing doesn't reveal which emails exist.
const DUMMY_HASH = await hash('timing-equaliser-not-a-real-password', ARGON2_OPTIONS);

export interface ClientMeta {
  userAgent?: string;
  ip?: string;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
  refreshToken: string;
  refreshExpiresAt: Date;
}

let googleClient: OAuth2Client | undefined;

function refreshExpiry(): Date {
  return new Date(Date.now() + config.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function issueSession(user: User, meta: ClientMeta): Promise<AuthResult> {
  const secret = newRefreshSecret();
  const refreshExpiresAt = refreshExpiry();
  const session = await refreshSessionsRepository.create({
    userId: user._id.toString(),
    tokenHash: hashSecret(secret),
    expiresAt: refreshExpiresAt,
    userAgent: meta.userAgent?.slice(0, 512),
    ip: meta.ip,
  });
  return {
    user: toPublicUser(user),
    accessToken: signAccessToken({ id: user._id.toString(), role: user.role }),
    expiresIn: config.JWT_ACCESS_TTL_SECONDS,
    refreshToken: formatRefreshToken(session._id.toString(), secret),
    refreshExpiresAt,
  };
}

export const authService = {
  async register(input: RegisterInput, meta: ClientMeta): Promise<AuthResult> {
    if (await usersRepository.findByEmail(input.email)) {
      throw Errors.conflict('An account with this email already exists');
    }
    const user = await usersRepository.create({
      email: input.email,
      name: input.name,
      authProvider: 'password',
      passwordHash: await hash(input.password, ARGON2_OPTIONS),
    });
    return issueSession(user, meta);
  },

  async login(input: LoginInput, meta: ClientMeta): Promise<AuthResult> {
    const user = await usersRepository.findByEmail(input.email, { withPassword: true });
    const valid = await verify(user?.passwordHash ?? DUMMY_HASH, input.password);
    if (!user?.passwordHash || !valid) throw Errors.unauthorized('Invalid email or password');
    return issueSession(user, meta);
  },

  async loginWithGoogle(input: GoogleLoginInput, meta: ClientMeta): Promise<AuthResult> {
    if (!config.GOOGLE_CLIENT_ID) throw Errors.unavailable('Google sign-in is not configured');
    googleClient ??= new OAuth2Client(config.GOOGLE_CLIENT_ID);

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: input.idToken,
        audience: config.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      throw Errors.unauthorized('Invalid Google credential');
    }
    if (!payload?.sub || !payload.email || !payload.email_verified) {
      throw Errors.unauthorized('Google account email is not verified');
    }

    let user = await usersRepository.findByGoogleId(payload.sub);
    if (!user) {
      const byEmail = await usersRepository.findByEmail(payload.email);
      user = byEmail
        ? await usersRepository.linkGoogle(byEmail._id.toString(), payload.sub)
        : await usersRepository.create({
            email: payload.email,
            name: payload.name,
            authProvider: 'google',
            googleId: payload.sub,
          });
    }
    if (!user) throw Errors.unauthorized();
    return issueSession(user, meta);
  },

  /**
   * Rotates the refresh token on every use. Presenting an already-rotated token means it
   * leaked (or two tabs raced): the whole session is revoked and the user must sign in again.
   */
  async refresh(token: string | undefined): Promise<AuthResult> {
    const parsed = token ? parseRefreshToken(token) : null;
    if (!parsed) throw Errors.unauthorized('Missing or malformed refresh token');

    const nextSecret = newRefreshSecret();
    const refreshExpiresAt = refreshExpiry();
    const session = await refreshSessionsRepository.rotate(
      parsed.sessionId,
      hashSecret(parsed.secret),
      hashSecret(nextSecret),
      refreshExpiresAt,
    );
    if (!session) {
      await refreshSessionsRepository.deleteById(parsed.sessionId);
      throw Errors.unauthorized('Session expired, please sign in again');
    }

    const user = await usersRepository.findById(session.userId.toString());
    if (!user) throw Errors.unauthorized();
    return {
      user: toPublicUser(user),
      accessToken: signAccessToken({ id: user._id.toString(), role: user.role }),
      expiresIn: config.JWT_ACCESS_TTL_SECONDS,
      refreshToken: formatRefreshToken(parsed.sessionId, nextSecret),
      refreshExpiresAt,
    };
  },

  async logout(token: string | undefined): Promise<void> {
    const parsed = token ? parseRefreshToken(token) : null;
    if (!parsed) return;
    await refreshSessionsRepository.deleteByIdAndHash(parsed.sessionId, hashSecret(parsed.secret));
  },
};

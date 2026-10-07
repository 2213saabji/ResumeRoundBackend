import type { CookieOptions, Request, Response } from 'express';
import { config } from '../../common/config.js';
import type { GoogleLoginInput, LoginInput, RegisterInput } from './schemas.js';
import { authService, type AuthResult, type ClientMeta } from './service.js';

export const REFRESH_COOKIE = 'rr_refresh';

const cookieBase: CookieOptions = {
  httpOnly: true,
  secure: config.COOKIE_SECURE,
  sameSite: config.COOKIE_SAMESITE,
  path: '/api/v1/auth',
};

function meta(req: Request): ClientMeta {
  return { userAgent: req.header('user-agent'), ip: req.ip };
}

function respond(res: Response, result: AuthResult, status = 200) {
  res.cookie(REFRESH_COOKIE, result.refreshToken, {
    ...cookieBase,
    expires: result.refreshExpiresAt,
  });
  res.status(status).json({
    user: result.user,
    accessToken: result.accessToken,
    expiresIn: result.expiresIn,
  });
}

function refreshTokenFrom(req: Request): string | undefined {
  const fromCookie = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
  return fromCookie;
}

export const authController = {
  async register(req: Request, res: Response) {
    respond(res, await authService.register(req.body as RegisterInput, meta(req)), 201);
  },

  async login(req: Request, res: Response) {
    respond(res, await authService.login(req.body as LoginInput, meta(req)));
  },

  async google(req: Request, res: Response) {
    respond(res, await authService.loginWithGoogle(req.body as GoogleLoginInput, meta(req)));
  },

  async refresh(req: Request, res: Response) {
    try {
      respond(res, await authService.refresh(refreshTokenFrom(req)));
    } catch (err) {
      res.clearCookie(REFRESH_COOKIE, cookieBase);
      throw err;
    }
  },

  async logout(req: Request, res: Response) {
    await authService.logout(refreshTokenFrom(req));
    res.clearCookie(REFRESH_COOKIE, cookieBase);
    res.status(204).end();
  },
};

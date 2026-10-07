import type { AuthUser } from '../modules/auth/tokens.js';

declare global {
  namespace Express {
    interface Request {
      requestId: string;
      user?: AuthUser;
    }
  }
}

export {};

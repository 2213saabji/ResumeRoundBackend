import { Router } from 'express';
import { rateLimit } from '../../common/middleware/rate-limit.js';
import { validate } from '../../common/middleware/validate.js';
import { authController } from './controller.js';
import { googleLoginSchema, loginSchema, registerSchema } from './schemas.js';

export const authRouter = Router();

const authLimit = rateLimit({ name: 'auth', windowMs: 60_000, max: 20, keyBy: 'ip' });

authRouter.post(
  '/register',
  authLimit,
  validate({ body: registerSchema }),
  authController.register,
);
authRouter.post('/login', authLimit, validate({ body: loginSchema }), authController.login);
authRouter.post('/google', authLimit, validate({ body: googleLoginSchema }), authController.google);
authRouter.post('/refresh', authLimit, authController.refresh);
authRouter.post('/logout', authController.logout);

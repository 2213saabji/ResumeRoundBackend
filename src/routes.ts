import { Router } from 'express';
import { authRouter } from './modules/auth/routes.js';
import { interviewsRouter } from './modules/interviews/routes.js';
import { profilesRouter } from './modules/profiles/routes.js';
import { progressRouter } from './modules/progress/routes.js';
import { resumesRouter } from './modules/resumes/routes.js';
import { meRouter } from './modules/users/routes.js';

/** Everything under /api/v1. */
export const apiRouter = Router();

apiRouter.use('/auth', authRouter);
apiRouter.use('/me', meRouter);
apiRouter.use('/users/me/progress', progressRouter);
apiRouter.use('/resumes', resumesRouter);
apiRouter.use('/profiles', profilesRouter);
apiRouter.use('/interviews', interviewsRouter);

import { Router } from 'express';
import { idempotency } from '../../common/middleware/idempotency.js';
import { rateLimit } from '../../common/middleware/rate-limit.js';
import { validate } from '../../common/middleware/validate.js';
import { idParamsSchema } from '../../common/validation.js';
import { authenticate } from '../auth/middleware.js';
import { interviewsController } from './controller.js';
import { createInterviewSchema, listTurnsQuerySchema } from './schemas.js';

export const interviewsRouter = Router();

const byId = validate({ params: idParamsSchema });

interviewsRouter.use(authenticate);
interviewsRouter.post(
  '/',
  rateLimit({ name: 'interview-create', windowMs: 60 * 60 * 1000, max: 10, keyBy: 'user' }),
  validate({ body: createInterviewSchema }),
  idempotency,
  interviewsController.create,
);
interviewsRouter.get('/:id', byId, interviewsController.get);
interviewsRouter.post('/:id/join', byId, interviewsController.join);
interviewsRouter.post('/:id/answers', byId, interviewsController.submitAnswer);
interviewsRouter.get(
  '/:id/turns',
  validate({ params: idParamsSchema, query: listTurnsQuerySchema }),
  interviewsController.listTurns,
);
interviewsRouter.post('/:id/end', byId, interviewsController.end);
interviewsRouter.get('/:id/report', byId, interviewsController.getReport);

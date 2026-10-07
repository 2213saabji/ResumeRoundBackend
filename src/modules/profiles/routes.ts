import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { authenticate } from '../auth/middleware.js';
import { profilesController } from './controller.js';
import { updateProfileSchema } from './schemas.js';

export const profilesRouter = Router();

profilesRouter.use(authenticate);
profilesRouter.get('/current', profilesController.getCurrent);
profilesRouter.patch(
  '/current',
  validate({ body: updateProfileSchema }),
  profilesController.updateCurrent,
);

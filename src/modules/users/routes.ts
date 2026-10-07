import { Router } from 'express';
import { validate } from '../../common/middleware/validate.js';
import { authenticate } from '../auth/middleware.js';
import { usersController } from './controller.js';
import { updateMeSchema } from './schemas.js';

export const meRouter = Router();

meRouter.get('/', authenticate, usersController.getMe);
meRouter.patch('/', authenticate, validate({ body: updateMeSchema }), usersController.updateMe);

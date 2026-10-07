import { Router } from 'express';
import multer from 'multer';
import { idempotency } from '../../common/middleware/idempotency.js';
import { rateLimit } from '../../common/middleware/rate-limit.js';
import { validate } from '../../common/middleware/validate.js';
import { idParamsSchema } from '../../common/validation.js';
import { authenticate } from '../auth/middleware.js';
import { resumesController } from './controller.js';

export const MAX_RESUME_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1, fields: 5 },
});

export const resumesRouter = Router();

resumesRouter.use(authenticate);
resumesRouter.post(
  '/',
  rateLimit({ name: 'resume-upload', windowMs: 60 * 60 * 1000, max: 20, keyBy: 'user' }),
  upload.single('file'),
  idempotency,
  resumesController.upload,
);
resumesRouter.get('/:id', validate({ params: idParamsSchema }), resumesController.get);

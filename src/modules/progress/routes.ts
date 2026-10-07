import { Router, type Request, type Response } from 'express';
import { authenticate, requireUser } from '../auth/middleware.js';
import { progressService } from './service.js';

export const progressRouter = Router();

progressRouter.get('/', authenticate, async (req: Request, res: Response) => {
  res.json(await progressService.getProgress(requireUser(req).id));
});

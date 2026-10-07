import type { Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { UpdateMeInput } from './schemas.js';
import { usersService } from './service.js';

export const usersController = {
  async getMe(req: Request, res: Response) {
    const user = await usersService.getMe(requireUser(req).id);
    res.json({ user });
  },

  async updateMe(req: Request, res: Response) {
    const user = await usersService.updateMe(requireUser(req).id, req.body as UpdateMeInput);
    res.json({ user });
  },
};

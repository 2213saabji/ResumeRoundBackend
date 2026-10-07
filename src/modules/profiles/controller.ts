import type { Request, Response } from 'express';
import { requireUser } from '../auth/middleware.js';
import type { UpdateProfileInput } from './schemas.js';
import { profilesService } from './service.js';

export const profilesController = {
  async getCurrent(req: Request, res: Response) {
    res.json({ profile: await profilesService.getCurrent(requireUser(req).id) });
  },

  async updateCurrent(req: Request, res: Response) {
    const profile = await profilesService.updateCurrent(
      requireUser(req).id,
      req.body as UpdateProfileInput,
    );
    res.json({ profile });
  },
};

import type { Request, Response } from 'express';
import type { IdParams } from '../../common/validation.js';
import { requireUser } from '../auth/middleware.js';
import { resumesService } from './service.js';

export const resumesController = {
  async upload(req: Request, res: Response) {
    const resume = await resumesService.upload(requireUser(req).id, req.file);
    res.status(202).location(`/api/v1/resumes/${resume.id}`).json({ resume });
  },

  async get(req: Request, res: Response) {
    const { id } = req.params as IdParams;
    res.json({ resume: await resumesService.get(requireUser(req).id, id) });
  },
};

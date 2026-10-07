import type { Request, Response } from 'express';
import { Errors } from '../../common/errors.js';
import type { CursorQuery } from '../../common/pagination.js';
import type { IdParams } from '../../common/validation.js';
import { requireUser } from '../auth/middleware.js';
import type { CreateInterviewInput } from './schemas.js';
import { interviewsService } from './service.js';

export const interviewsController = {
  async create(req: Request, res: Response) {
    const interview = await interviewsService.create(
      requireUser(req).id,
      req.body as CreateInterviewInput,
    );
    res.status(201).location(`/api/v1/interviews/${interview.id}`).json({ interview });
  },

  async get(req: Request, res: Response) {
    const { id } = req.params as IdParams;
    res.json({ interview: await interviewsService.get(requireUser(req).id, id) });
  },

  async listTurns(req: Request, res: Response) {
    const { id } = req.params as IdParams;
    const { cursor, limit } = req.query as unknown as CursorQuery;
    res.json(await interviewsService.listTurns(requireUser(req).id, id, cursor, limit));
  },

  async end(req: Request, res: Response) {
    const { id } = req.params as IdParams;
    res.json({ interview: await interviewsService.end(requireUser(req).id, id) });
  },

  async getReport(req: Request, res: Response) {
    const { id } = req.params as IdParams;
    const report = await interviewsService.getReport(requireUser(req).id, id);
    if (!report) {
      res.status(202).setHeader('Retry-After', '5');
      res.json({ status: 'generating' });
      return;
    }
    res.json({ status: 'ready', report });
  },

  /** MVP-4: create/get Janus room, assign a bot, return Janus URL + join token + ICE servers. */
  async join() {
    throw Errors.notImplemented('Joining a live interview call');
  },

  /** MVP-2: text-fallback answer -> evaluate -> controller.decide -> next question. */
  async submitAnswer() {
    throw Errors.notImplemented('Submitting answers');
  },
};

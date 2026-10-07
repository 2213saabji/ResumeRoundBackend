import type { JobHandler } from '../jobs/worker.js';
import { resumesService } from './service.js';

export const parseResumeJob: JobHandler<'resume.parse'> = (payload, ctx) =>
  resumesService.parse(payload.resumeId, ctx);

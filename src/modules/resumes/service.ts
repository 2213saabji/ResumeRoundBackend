import { Types } from 'mongoose';
import { withTransaction } from '../../common/db.js';
import { Errors } from '../../common/errors.js';
import { getStorage } from '../../common/storage/index.js';
import { getAiGateway } from '../ai/gateway.js';
import { AiError } from '../ai/types.js';
import { jobQueue, NonRetryableError } from '../jobs/queue.js';
import type { JobContext } from '../jobs/worker.js';
import { profilesRepository } from '../profiles/repository.js';
import { detectResumeFileType } from './file-type.js';
import type { Resume } from './model.js';
import { resumesRepository } from './repository.js';
import { extractResumeText } from './text-extraction.js';

const MIN_TEXT_CHARS = 100;
const MAX_TEXT_CHARS = 60_000;
const GENERIC_FAILURE =
  'We could not process this resume. Please try again or upload a different file.';

export function toPublicResume(r: Resume) {
  return {
    id: r._id.toString(),
    status: r.status,
    originalName: r.originalName ?? null,
    mimeType: r.mimeType,
    sizeBytes: r.sizeBytes,
    profileId: r.profileId?.toString() ?? null,
    error: r.error ?? null,
    createdAt: r.createdAt,
    parsedAt: r.parsedAt ?? null,
  };
}

export const resumesService = {
  async upload(
    userId: string,
    file: { buffer: Buffer; originalname: string; size: number } | undefined,
  ) {
    if (!file) throw Errors.badRequest('A resume file is required in the "file" field');
    const type = detectResumeFileType(file.buffer);
    if (!type) throw Errors.unsupportedMediaType('Only PDF and DOCX resumes are supported');

    const id = new Types.ObjectId();
    const fileKey = `resumes/${userId}/${id.toString()}.${type.ext}`;
    await getStorage().put(fileKey, file.buffer, type.mimeType);

    const resume = await withTransaction(async (session) => {
      const created = await resumesRepository.create(
        {
          _id: id,
          userId,
          fileKey,
          originalName: file.originalname.slice(0, 255),
          mimeType: type.mimeType,
          sizeBytes: file.size,
        },
        session,
      );
      await jobQueue.enqueue('resume.parse', { resumeId: id.toString() }, { session });
      return created;
    });
    return toPublicResume(resume);
  },

  async get(userId: string, id: string) {
    const resume = await resumesRepository.findForUser(id, userId);
    if (!resume) throw Errors.notFound('Resume');
    return toPublicResume(resume);
  },

  /** Job handler body for `resume.parse`. Idempotent: safe to run again after a crash. */
  async parse(resumeId: string, ctx: Pick<JobContext, 'isFinalAttempt' | 'log'>): Promise<void> {
    const resume = await resumesRepository.findByIdWithText(resumeId);
    if (!resume) throw new NonRetryableError(`Resume ${resumeId} not found`);
    if (resume.status === 'ready') return;

    await resumesRepository.setStatus(resumeId, 'parsing');
    try {
      let text = resume.rawText;
      if (!text) {
        const buf = await getStorage().get(resume.fileKey);
        text = await extractResumeText(buf, resume.mimeType);
        if (text.length < MIN_TEXT_CHARS) {
          throw new NonRetryableError(
            'We could not read any text from this resume. If it is a scanned image, please upload a text-based PDF or DOCX.',
          );
        }
        if (text.length > MAX_TEXT_CHARS) {
          throw new NonRetryableError(
            'This resume is too long. Please upload a resume of at most a few pages.',
          );
        }
        await resumesRepository.saveText(resumeId, text);
      }

      const userId = resume.userId.toString();
      const analysis = await getAiGateway().analyzeResume(text, { userId });

      await withTransaction(async (session) => {
        const profile = await profilesRepository.replaceActive(userId, resumeId, analysis, session);
        await resumesRepository.markReady(resumeId, profile._id, session);
      });
      ctx.log.info({ resumeId }, 'resume parsed');
    } catch (err) {
      const permanent =
        err instanceof NonRetryableError || (err instanceof AiError && !err.retryable);
      if (permanent || ctx.isFinalAttempt) {
        await resumesRepository.markFailed(
          resumeId,
          err instanceof NonRetryableError ? err.message : GENERIC_FAILURE,
        );
      }
      if (err instanceof AiError && !err.retryable) throw new NonRetryableError(err.message);
      throw err;
    }
  },
};

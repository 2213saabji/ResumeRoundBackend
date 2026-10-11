/**
 * Deletes a user account and everything linked to it: resumes (and their stored files),
 * profiles, interviews, turns, transcripts, reports, progress history, AI usage, jobs,
 * sessions, idempotency keys and per-user rate-limit windows.
 *
 *   npx tsx src/scripts/delete-user.ts <email>             # dry run: shows what would go
 *   npx tsx src/scripts/delete-user.ts <email> --confirm   # deletes
 *
 * Database deletes run in one transaction; stored files are removed after it commits.
 */
import type { Types } from 'mongoose';
import { config } from '../common/config.js';
import { connectDb, disconnectDb, withTransaction } from '../common/db.js';
import { IdempotencyKeyModel } from '../common/middleware/idempotency.js';
import { RateLimitModel } from '../common/middleware/rate-limit.js';
import { getStorage } from '../common/storage/index.js';
import { AiUsageModel } from '../modules/ai/cost-meter.js';
import { RefreshSessionModel } from '../modules/auth/model.js';
import {
  InterviewModel,
  InterviewTurnModel,
  TranscriptEventModel,
} from '../modules/interviews/model.js';
import { JobModel } from '../modules/jobs/model.js';
import { CandidateProfileModel } from '../modules/profiles/model.js';
import { SkillHistoryModel } from '../modules/progress/model.js';
import { ReportModel } from '../modules/reports/model.js';
import { ResumeModel } from '../modules/resumes/model.js';
import { UserModel } from '../modules/users/model.js';

/* eslint-disable no-console */
const email = process.argv[2]?.trim().toLowerCase();
const confirm = process.argv.includes('--confirm');
if (!email || !email.includes('@')) {
  console.error('Usage: npx tsx src/scripts/delete-user.ts <email> [--confirm]');
  process.exit(1);
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

await connectDb(config.MONGODB_URI);
try {
  const user = await UserModel.findOne({ email }).lean();
  if (!user) {
    console.log(`No user with email ${email}.`);
  } else {
    const userId = user._id as Types.ObjectId;
    const resumes = await ResumeModel.find({ userId }).select({ fileKey: 1 }).lean();
    const interviews = await InterviewModel.find({ userId }).select({ _id: 1 }).lean();
    const resumeIds = resumes.map((r) => r._id);
    const interviewIds = interviews.map((i) => i._id);
    const fileKeys = resumes.map((r) => r.fileKey);

    const targets = [
      ['interview_turns', InterviewTurnModel, { interviewId: { $in: interviewIds } }],
      ['transcript_events', TranscriptEventModel, { interviewId: { $in: interviewIds } }],
      ['reports', ReportModel, { $or: [{ userId }, { interviewId: { $in: interviewIds } }] }],
      ['skill_history', SkillHistoryModel, { userId }],
      ['ai_usage', AiUsageModel, { $or: [{ userId }, { interviewId: { $in: interviewIds } }] }],
      [
        'jobs',
        JobModel,
        {
          $or: [
            { 'payload.resumeId': { $in: resumeIds.map(String) } },
            { 'payload.interviewId': { $in: interviewIds.map(String) } },
          ],
        },
      ],
      ['interviews', InterviewModel, { userId }],
      ['candidate_profiles', CandidateProfileModel, { userId }],
      ['resumes', ResumeModel, { userId }],
      ['refresh_sessions', RefreshSessionModel, { userId }],
      ['idempotency_keys', IdempotencyKeyModel, { userId: String(userId) }],
      ['rate_limits', RateLimitModel, { key: { $regex: `:u:${escapeRegex(String(userId))}:` } }],
      ['users', UserModel, { _id: userId }],
    ] as const;

    console.log(`User ${email} (id ${String(userId)}, created ${user.createdAt?.toISOString()})`);
    for (const [name, model, filter] of targets) {
      // The tuple mixes model types; each filter matches its own model's schema.
      const count = await (model as typeof UserModel).countDocuments(filter as object);
      console.log(`  ${name.padEnd(20)} ${count}`);
    }
    console.log(`  ${'stored files'.padEnd(20)} ${fileKeys.length}`);

    if (!confirm) {
      console.log('\nDry run: nothing deleted. Re-run with --confirm to delete.');
    } else {
      await withTransaction(async (session) => {
        for (const [, model, filter] of targets) {
          await (model as typeof UserModel).deleteMany(filter as object, { session });
        }
      });
      const storage = getStorage();
      let filesFailed = 0;
      for (const key of fileKeys) {
        await storage.delete(key).catch(() => filesFailed++);
      }
      const left = await UserModel.countDocuments({ email });
      console.log(
        `\nDeleted. Users left with this email: ${left}. Files not removed: ${filesFailed}.`,
      );
    }
  }
} finally {
  await disconnectDb();
}

import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/** Typed payload for every job type. Add new job types here. */
export interface JobPayloads {
  'resume.parse': { resumeId: string };
  'report.generate': { interviewId: string };
}
export type JobType = keyof JobPayloads;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'dead'] as const;

/** MongoDB-backed job queue (replaces Redis/BullMQ). */
const jobSchema = new Schema(
  {
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: JOB_STATUSES, default: 'queued', required: true },
    attempts: { type: Number, default: 0, required: true },
    maxAttempts: { type: Number, default: 5, required: true },
    runAt: { type: Date, default: () => new Date(), required: true },
    lockedBy: { type: String },
    lockedUntil: { type: Date },
    lastError: { type: String },
    completedAt: { type: Date },
  },
  { timestamps: true, collection: 'jobs', minimize: false },
);

// Claim path: queued jobs that are due, or running jobs whose lock expired (crashed worker).
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
// Succeeded jobs are kept for a week for debugging; dead jobs stay until someone looks at them.
jobSchema.index(
  { completedAt: 1 },
  { expireAfterSeconds: 7 * 24 * 60 * 60, partialFilterExpression: { status: 'succeeded' } },
);

export type Job = InferSchemaType<typeof jobSchema> & { _id: Types.ObjectId };
export const JobModel = model('Job', jobSchema);

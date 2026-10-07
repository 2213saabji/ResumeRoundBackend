import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

export const RESUME_STATUSES = ['uploaded', 'parsing', 'ready', 'failed'] as const;
export type ResumeStatus = (typeof RESUME_STATUSES)[number];

const resumeSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    fileKey: { type: String, required: true },
    originalName: { type: String, maxlength: 255 },
    mimeType: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    status: { type: String, enum: RESUME_STATUSES, default: 'uploaded', required: true },
    // PII: never returned by default, never exported to analytics.
    rawText: { type: String, select: false },
    profileId: { type: Schema.Types.ObjectId, ref: 'CandidateProfile' },
    error: { type: String },
    parsedAt: { type: Date },
  },
  { timestamps: true, collection: 'resumes' },
);

resumeSchema.index({ userId: 1, createdAt: -1 });

export type Resume = InferSchemaType<typeof resumeSchema> & { _id: Types.ObjectId };
export const ResumeModel = model('Resume', resumeSchema);

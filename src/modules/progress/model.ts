import { Schema, model, type InferSchemaType, type Types } from 'mongoose';

/** One row per skill per interview; the planner reads the latest score per skill. */
const skillHistorySchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    skill: { type: String, required: true, lowercase: true, trim: true },
    score: { type: Number, min: 0, max: 10, required: true },
    interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true },
    at: { type: Date, default: () => new Date(), required: true },
  },
  { versionKey: false, collection: 'skill_history' },
);
skillHistorySchema.index({ userId: 1, skill: 1, at: -1 });

export type SkillHistory = InferSchemaType<typeof skillHistorySchema> & { _id: Types.ObjectId };
export const SkillHistoryModel = model('SkillHistory', skillHistorySchema);

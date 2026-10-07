import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { LEVELS } from '../../common/domain.js';

const projectSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 200 },
    technologies: { type: [String], default: [] },
    description: { type: String, maxlength: 2000, default: '' },
    scaleSignals: { type: [String], default: [] },
  },
  { _id: false },
);

const skillsSchema = new Schema(
  {
    languages: { type: [String], default: [] },
    frameworks: { type: [String], default: [] },
    databases: { type: [String], default: [] },
    cloud: { type: [String], default: [] },
    architecture: { type: [String], default: [] },
  },
  { _id: false },
);

const profileSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    resumeId: { type: Schema.Types.ObjectId, ref: 'Resume' },
    isActive: { type: Boolean, default: true, required: true },
    experienceYears: { type: Number, min: 0, max: 50, default: 0 },
    seniority: { type: String, enum: LEVELS, required: true },
    domain: { type: String, default: null },
    skills: { type: skillsSchema, required: true, default: () => ({}) },
    projects: { type: [projectSchema], default: [] },
    editedByUser: { type: Boolean, default: false },
  },
  { timestamps: true, collection: 'candidate_profiles' },
);

// Exactly one active profile per user; older ones are kept for history.
profileSchema.index({ userId: 1 }, { unique: true, partialFilterExpression: { isActive: true } });
profileSchema.index({ userId: 1, createdAt: -1 });

export type CandidateProfile = InferSchemaType<typeof profileSchema> & { _id: Types.ObjectId };
export const CandidateProfileModel = model('CandidateProfile', profileSchema);

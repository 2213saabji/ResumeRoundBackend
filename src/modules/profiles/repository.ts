import type { ClientSession } from 'mongoose';
import type { ResumeAnalysis } from '../ai/schemas.js';
import { CandidateProfileModel, type CandidateProfile } from './model.js';
import type { UpdateProfileInput } from './schemas.js';

export const profilesRepository = {
  findActive(userId: string): Promise<CandidateProfile | null> {
    return CandidateProfileModel.findOne({ userId, isActive: true }).lean<CandidateProfile>();
  },

  findById(id: string): Promise<CandidateProfile | null> {
    return CandidateProfileModel.findById(id).lean<CandidateProfile>();
  },

  /** Deactivates the current profile and stores a new active one. Run inside a transaction. */
  async replaceActive(
    userId: string,
    resumeId: string,
    analysis: ResumeAnalysis,
    session: ClientSession,
  ): Promise<CandidateProfile> {
    await CandidateProfileModel.updateMany(
      { userId, isActive: true },
      { $set: { isActive: false } },
      { session },
    );
    const [doc] = await CandidateProfileModel.create(
      [{ userId, resumeId, isActive: true, editedByUser: false, ...analysis }],
      { session },
    );
    return doc!.toObject<CandidateProfile>();
  },

  updateActive(userId: string, patch: UpdateProfileInput): Promise<CandidateProfile | null> {
    return CandidateProfileModel.findOneAndUpdate(
      { userId, isActive: true },
      { $set: { ...patch, editedByUser: true } },
      { returnDocument: 'after', runValidators: true },
    ).lean<CandidateProfile>();
  },
};

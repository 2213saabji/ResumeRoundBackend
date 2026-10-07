import type { ClientSession, Types } from 'mongoose';
import { ResumeModel, type Resume, type ResumeStatus } from './model.js';

export const resumesRepository = {
  async create(
    data: {
      _id: Types.ObjectId;
      userId: string;
      fileKey: string;
      originalName?: string;
      mimeType: string;
      sizeBytes: number;
    },
    session?: ClientSession,
  ): Promise<Resume> {
    const [doc] = await ResumeModel.create([data], { session });
    return doc!.toObject<Resume>();
  },

  findForUser(id: string, userId: string): Promise<Resume | null> {
    return ResumeModel.findOne({ _id: id, userId }).lean<Resume>();
  },

  findByIdWithText(id: string): Promise<Resume | null> {
    return ResumeModel.findById(id).select('+rawText').lean<Resume>();
  },

  async setStatus(id: string, status: ResumeStatus): Promise<void> {
    await ResumeModel.updateOne({ _id: id }, { $set: { status }, $unset: { error: 1 } });
  },

  async saveText(id: string, rawText: string): Promise<void> {
    await ResumeModel.updateOne({ _id: id }, { $set: { rawText } });
  },

  async markReady(id: string, profileId: Types.ObjectId, session: ClientSession): Promise<void> {
    await ResumeModel.updateOne(
      { _id: id },
      { $set: { status: 'ready', profileId, parsedAt: new Date() }, $unset: { error: 1 } },
      { session },
    );
  },

  async markFailed(id: string, error: string): Promise<void> {
    await ResumeModel.updateOne({ _id: id }, { $set: { status: 'failed', error } });
  },
};

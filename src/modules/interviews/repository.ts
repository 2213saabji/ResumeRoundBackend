import type { ClientSession } from 'mongoose';
import { Errors } from '../../common/errors.js';
import type { PlanObjective } from './engine/types.js';
import { InterviewModel, InterviewTurnModel, type Interview, type InterviewTurn } from './model.js';

export type NewInterview = Pick<
  Interview,
  | 'userId'
  | 'profileId'
  | 'role'
  | 'level'
  | 'companyType'
  | 'mode'
  | 'status'
  | 'durationSec'
  | 'state'
> & { plan: PlanObjective[] };

export const interviewsRepository = {
  async create(data: NewInterview): Promise<Interview> {
    const doc = await InterviewModel.create(data);
    return doc.toObject<Interview>();
  },

  findForUser(id: string, userId: string): Promise<Interview | null> {
    return InterviewModel.findOne({ _id: id, userId }).lean<Interview>();
  },

  countCreatedSince(userId: string, since: Date): Promise<number> {
    return InterviewModel.countDocuments({ userId, createdAt: { $gte: since } });
  },

  /**
   * Per-turn checkpoint with optimistic locking. Fails with 409 if another writer
   * (e.g. a bot that took over after failover) already advanced the interview.
   */
  async checkpoint(id: string, expectedVersion: number, state: Interview['state']): Promise<void> {
    const res = await InterviewModel.updateOne(
      { _id: id, version: expectedVersion },
      { $set: { state }, $inc: { version: 1 } },
    );
    if (res.matchedCount === 0) throw Errors.conflict('Interview state was modified concurrently');
  },

  /** Ends a live interview; returns null if it was already ended. */
  end(
    id: string,
    userId: string,
    reason: NonNullable<Interview['endReason']>,
    session: ClientSession,
  ) {
    return InterviewModel.findOneAndUpdate(
      { _id: id, userId, status: { $in: ['created', 'in_progress'] } },
      {
        $set: { status: 'ended', endedAt: new Date(), endReason: reason, 'state.phase': 'ended' },
        $inc: { version: 1 },
      },
      { returnDocument: 'after', session },
    ).lean<Interview>();
  },

  listTurns(interviewId: string, afterSeq: number, limit: number): Promise<InterviewTurn[]> {
    return InterviewTurnModel.find({ interviewId, seq: { $gt: afterSeq } })
      .sort({ seq: 1 })
      .limit(limit)
      .lean<InterviewTurn[]>();
  },
};

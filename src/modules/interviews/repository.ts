import type { ClientSession, Types } from 'mongoose';
import { Errors } from '../../common/errors.js';
import type { Move, ObjectiveKind, PlanObjective } from './engine/types.js';
import type { QuestionMove } from '../ai/types.js';
import {
  InterviewModel,
  InterviewTurnModel,
  type Interview,
  type InterviewStatus,
  type ReportStatus,
  type InterviewTurn,
} from './model.js';

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

  findById(id: string): Promise<Interview | null> {
    return InterviewModel.findById(id).lean<Interview>();
  },

  async setReportStatus(id: string, reportStatus: ReportStatus, session?: ClientSession) {
    await InterviewModel.updateOne({ _id: id }, { $set: { reportStatus } }, { session });
  },

  /**
   * Interviews that ended before report generation existed have no reportStatus. Claims one
   * (sets 'pending') exactly once, so its report job is queued a single time.
   */
  async claimLegacyReport(id: string, session: ClientSession): Promise<boolean> {
    const res = await InterviewModel.updateOne(
      { _id: id, status: 'ended', reportStatus: { $exists: false } },
      { $set: { reportStatus: 'pending' } },
      { session },
    );
    return res.modifiedCount === 1;
  },

  /**
   * Stores the call room the first time an interview is joined. Returns false if another
   * request stored one first (the caller reloads and uses that). Does not bump `version`:
   * call details are not interview state.
   */
  async claimCallRoom(
    id: string,
    room: { roomId: number; roomSecret: string; roomPin: string },
  ): Promise<boolean> {
    const res = await InterviewModel.updateOne(
      { _id: id, 'janus.roomId': { $exists: false } },
      {
        $set: {
          'janus.roomId': room.roomId,
          'janus.roomSecret': room.roomSecret,
          'janus.roomPin': room.roomPin,
        },
      },
    );
    return res.modifiedCount === 1;
  },

  async assignBot(id: string, botId: string): Promise<void> {
    await InterviewModel.updateOne(
      { _id: id },
      { $set: { 'janus.botId': botId, 'janus.botLastSeenAt': new Date() } },
    );
  },

  /** Live voice interviews this bot owns (the bot polls this to pick up and follow calls). */
  findLiveForBot(botId: string): Promise<Interview[]> {
    return InterviewModel.find({ 'janus.botId': botId, status: 'in_progress', mode: 'voice' }).lean<
      Interview[]
    >();
  },

  async touchBot(ids: string[], botId: string): Promise<void> {
    if (ids.length === 0) return;
    await InterviewModel.updateMany(
      { _id: { $in: ids }, 'janus.botId': botId },
      { $set: { 'janus.botLastSeenAt': new Date() } },
    );
  },

  findForUser(id: string, userId: string): Promise<Interview | null> {
    return InterviewModel.findOne({ _id: id, userId }).lean<Interview>();
  },

  countCreatedSince(userId: string, since: Date): Promise<number> {
    return InterviewModel.countDocuments({ userId, createdAt: { $gte: since } });
  },

  /**
   * Per-turn checkpoint with optimistic locking. Fails with 409 if another writer (a second
   * request, the user ending the interview, or a bot that took over) already changed it.
   */
  async checkpoint(
    id: string,
    expectedVersion: number,
    update: Pick<Interview, 'state'> &
      Partial<Pick<Interview, 'status' | 'startedAt' | 'endedAt' | 'endReason' | 'reportStatus'>>,
    opts: { expectedStatus?: InterviewStatus; session?: ClientSession } = {},
  ): Promise<void> {
    const res = await InterviewModel.updateOne(
      {
        _id: id,
        version: expectedVersion,
        ...(opts.expectedStatus ? { status: opts.expectedStatus } : {}),
      },
      { $set: update, $inc: { version: 1 } },
      { session: opts.session },
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
        $set: {
          status: 'ended',
          endedAt: new Date(),
          endReason: reason,
          reportStatus: 'pending',
          'state.phase': 'ended',
        },
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

  /** Every answered and scored turn, in order. */
  evaluatedTurns(interviewId: string): Promise<InterviewTurn[]> {
    return InterviewTurnModel.find({ interviewId, 'evaluation.overall': { $exists: true } })
      .sort({ seq: 1 })
      .lean<InterviewTurn[]>();
  },

  /** Every question asked so far, oldest first (used to avoid repeats). */
  async questionTexts(interviewId: string): Promise<string[]> {
    const turns = await InterviewTurnModel.find({ interviewId })
      .sort({ seq: 1 })
      .select({ questionText: 1 })
      .lean<{ questionText: string }[]>();
    return turns.map((t) => t.questionText);
  },

  getTurn(interviewId: string, seq: number): Promise<InterviewTurn | null> {
    return InterviewTurnModel.findOne({ interviewId, seq }).lean<InterviewTurn>();
  },

  /** The `limit` turns before `seq`, oldest first. */
  async turnsBefore(interviewId: string, seq: number, limit: number): Promise<InterviewTurn[]> {
    const turns = await InterviewTurnModel.find({ interviewId, seq: { $lt: seq } })
      .sort({ seq: -1 })
      .limit(limit)
      .lean<InterviewTurn[]>();
    return turns.reverse();
  },

  async insertTurn(turn: NewTurn, session: ClientSession): Promise<void> {
    await InterviewTurnModel.create([turn], { session });
  },

  /** Stores the answer text; allowed until the turn has been decided (so retries can resend). */
  async saveAnswer(interviewId: string, seq: number, answerText: string): Promise<boolean> {
    const res = await InterviewTurnModel.updateOne(
      { interviewId, seq, 'decision.move': { $exists: false } },
      { $set: { answerText, answeredAt: new Date() } },
    );
    return res.matchedCount === 1;
  },

  async recordEvaluation(
    interviewId: string,
    seq: number,
    result: {
      evaluation: TurnEvaluationRecord;
      decision: { move: Move; reason: string };
      latencyMs: number;
    },
    session: ClientSession,
  ): Promise<void> {
    await InterviewTurnModel.updateOne({ interviewId, seq }, { $set: result }, { session });
  },
};

export interface NewTurn {
  interviewId: Types.ObjectId;
  seq: number;
  objectiveIdx: number;
  objectiveKind: ObjectiveKind;
  move: QuestionMove;
  isFollowUp: boolean;
  questionText: string;
  spec: { expectedConcepts: string[]; goodAnswer: string };
  difficulty: number;
  askedAt: Date;
}

export interface TurnEvaluationRecord {
  dimensionScores: Record<string, number>;
  overall: number;
  confidence: number;
  isVague: boolean;
  evidence: { dimension: string; quote: string; note: string }[];
  coveredConcepts: string[];
  missedConcepts: string[];
  strengths: string[];
  weaknesses: string[];
}

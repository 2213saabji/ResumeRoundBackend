import { Schema, model, type InferSchemaType, type Types } from 'mongoose';
import { COMPANY_TYPES, LEVELS, TARGET_ROLES } from '../../common/domain.js';
import { PHASES } from './engine/state-machine.js';
import { MOVES, OBJECTIVE_KINDS, QUESTION_MOVES } from './engine/types.js';

export const INTERVIEW_STATUSES = ['created', 'in_progress', 'ended', 'abandoned'] as const;
export type InterviewStatus = (typeof INTERVIEW_STATUSES)[number];

export const REPORT_STATUSES = ['pending', 'ready', 'insufficient_answers', 'failed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

const objectiveSchema = new Schema(
  {
    kind: { type: String, enum: OBJECTIVE_KINDS, required: true },
    topic: { type: String, required: true },
    technologies: { type: [String], default: [] },
    projectName: { type: String, default: null },
    startDifficulty: { type: Number, min: 1, max: 10, required: true },
    timeBudgetSec: { type: Number, required: true },
    isCoreDeepDive: { type: Boolean, default: false },
  },
  { _id: false },
);

const interviewStateSchema = new Schema(
  {
    phase: { type: String, enum: PHASES, default: 'created', required: true },
    currentObjectiveIdx: { type: Number, default: 0, required: true },
    difficulty: { type: Number, min: 1, max: 10, required: true },
    followUpsOnThread: { type: Number, default: 0, required: true },
    hintsOnThread: { type: Number, default: 0, required: true },
    objectiveStartedAtSec: { type: Number, default: 0, required: true },
    questionsAsked: { type: Number, default: 0, required: true },
    strengths: { type: [String], default: [] },
    weaknesses: { type: [String], default: [] },
    // Concepts the candidate has already covered, so questions do not repeat them.
    coveredConcepts: { type: [String], default: [] },
    runningScores: { type: Schema.Types.Mixed, default: {} },
  },
  { _id: false, minimize: false },
);

const interviewSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    profileId: { type: Schema.Types.ObjectId, ref: 'CandidateProfile', required: true },
    role: { type: String, enum: TARGET_ROLES, required: true },
    level: { type: String, enum: LEVELS, required: true },
    companyType: { type: String, enum: COMPANY_TYPES, required: true },
    mode: { type: String, enum: ['voice', 'text'], default: 'voice', required: true },
    status: { type: String, enum: INTERVIEW_STATUSES, default: 'created', required: true },
    durationSec: { type: Number, required: true },
    plan: { type: [objectiveSchema], default: [] },
    // Embedded because it is read and written together with the interview, every turn.
    state: { type: interviewStateSchema, required: true },
    janus: {
      roomId: { type: Number },
      botId: { type: String },
      botLastSeenAt: { type: Date },
    },
    startedAt: { type: Date },
    endedAt: { type: Date },
    endReason: { type: String, enum: ['completed', 'user_ended', 'timeout', 'error'] },
    // Set to 'pending' when the interview ends and the report job is queued.
    reportStatus: { type: String, enum: REPORT_STATUSES },
  },
  // `version` guards per-turn checkpoints: a stale bot can never overwrite newer state.
  {
    timestamps: true,
    collection: 'interviews',
    versionKey: 'version',
    optimisticConcurrency: true,
  },
);

interviewSchema.index({ userId: 1, createdAt: -1 });
// Bot failover: find live interviews whose owning bot stopped heartbeating.
interviewSchema.index({ status: 1, 'janus.botLastSeenAt': 1 });

export type Interview = InferSchemaType<typeof interviewSchema> & {
  _id: Types.ObjectId;
  version: number;
};
export const InterviewModel = model('Interview', interviewSchema);

const turnSchema = new Schema(
  {
    interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true },
    seq: { type: Number, required: true },
    objectiveIdx: { type: Number, required: true },
    objectiveKind: { type: String, enum: OBJECTIVE_KINDS },
    // The controller move that produced this question ('opening' for the first one).
    move: { type: String, enum: QUESTION_MOVES },
    isFollowUp: { type: Boolean, default: false },
    questionId: { type: Schema.Types.ObjectId, ref: 'Question' },
    questionText: { type: String, required: true },
    // Hidden checklist the answer is scored against; never shown during the interview.
    spec: {
      expectedConcepts: { type: [String], default: [] },
      goodAnswer: { type: String, default: '' },
    },
    answerText: { type: String },
    answerAudioKey: { type: String },
    difficulty: { type: Number },
    evaluation: {
      dimensionScores: { type: Schema.Types.Mixed },
      overall: { type: Number },
      confidence: { type: Number },
      isVague: { type: Boolean },
      evidence: [{ _id: false, dimension: String, quote: String, note: String }],
      coveredConcepts: { type: [String], default: undefined },
      missedConcepts: { type: [String], default: undefined },
      strengths: { type: [String], default: undefined },
      weaknesses: { type: [String], default: undefined },
    },
    // What the controller decided after this answer.
    decision: {
      move: { type: String, enum: MOVES },
      reason: { type: String },
    },
    latencyMs: { type: Number },
    askedAt: { type: Date },
    answeredAt: { type: Date },
  },
  { timestamps: true, collection: 'interview_turns' },
);
turnSchema.index({ interviewId: 1, seq: 1 }, { unique: true });

export type InterviewTurn = InferSchemaType<typeof turnSchema> & { _id: Types.ObjectId };
export const InterviewTurnModel = model('InterviewTurn', turnSchema);

const transcriptEventSchema = new Schema(
  {
    interviewId: { type: Schema.Types.ObjectId, ref: 'Interview', required: true },
    speaker: { type: String, enum: ['candidate', 'interviewer'], required: true },
    text: { type: String, required: true },
    isFinal: { type: Boolean, required: true },
    ts: { type: Date, required: true },
    // Set on partial captions only, so they expire after 7 days while finals are kept.
    expireAt: { type: Date },
  },
  { versionKey: false, collection: 'transcript_events' },
);
transcriptEventSchema.index({ interviewId: 1, ts: 1 });
transcriptEventSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

export const TranscriptEventModel = model('TranscriptEvent', transcriptEventSchema);

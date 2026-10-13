import { config } from '../../common/config.js';
import { withTransaction } from '../../common/db.js';
import { Errors } from '../../common/errors.js';
import type { Page } from '../../common/pagination.js';
import { jobQueue } from '../jobs/queue.js';
import { joinCall } from '../media/calls.js';
import { profilesRepository } from '../profiles/repository.js';
import { progressService } from '../progress/service.js';
import { reportsService } from '../reports/service.js';
import { usersRepository } from '../users/repository.js';
import { buildPlan } from './engine/planner.js';
import type { Interview, InterviewTurn } from './model.js';
import { interviewsRepository } from './repository.js';
import { findCurrentTurn, interviewLoop, toProgress, toPublicCurrentTurn } from './loop.js';
import type { CreateInterviewInput, SubmitAnswerInput } from './schemas.js';

export function toPublicInterview(i: Interview) {
  return {
    id: i._id.toString(),
    status: i.status,
    mode: i.mode,
    role: i.role,
    level: i.level,
    companyType: i.companyType,
    durationSec: i.durationSec,
    plan: i.plan,
    state: {
      phase: i.state.phase,
      currentObjectiveIdx: i.state.currentObjectiveIdx,
      difficulty: i.state.difficulty,
      questionsAsked: i.state.questionsAsked,
    },
    startedAt: i.startedAt ?? null,
    endedAt: i.endedAt ?? null,
    createdAt: i.createdAt,
  };
}

/** Scores and decisions stay hidden until the interview has ended. */
function toPublicTurn(t: InterviewTurn, revealScores: boolean) {
  return {
    seq: t.seq,
    objectiveIdx: t.objectiveIdx,
    objectiveKind: t.objectiveKind ?? null,
    isFollowUp: t.isFollowUp ?? false,
    questionText: t.questionText,
    answerText: t.answerText ?? null,
    evaluation: revealScores && t.evaluation?.overall !== undefined ? t.evaluation : null,
    decision: revealScores && t.decision?.move ? t.decision : null,
    askedAt: t.askedAt ?? null,
    answeredAt: t.answeredAt ?? null,
  };
}

/** Shape shared by GET /interviews/:id, start and answers. */
async function view(i: Interview) {
  const turn = await findCurrentTurn(i);
  return {
    interview: toPublicInterview(i),
    progress: toProgress(i),
    currentTurn: turn ? toPublicCurrentTurn(turn) : null,
  };
}

function startOfMonthUtc(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

async function getOwned(userId: string, id: string): Promise<Interview> {
  const interview = await interviewsRepository.findForUser(id, userId);
  if (!interview) throw Errors.notFound('Interview');
  return interview;
}

export const interviewsService = {
  async create(userId: string, input: CreateInterviewInput) {
    const user = await usersRepository.findById(userId);
    if (!user) throw Errors.unauthorized();

    const role = input.role ?? user.targetRole;
    const level = input.level ?? user.level;
    const companyType = input.companyType ?? user.companyType;
    if (!role || !level || !companyType) {
      throw Errors.badRequest(
        'Set role, level and company type (in onboarding or in this request)',
      );
    }

    const profile = await profilesRepository.findActive(userId);
    if (!profile)
      throw Errors.conflict(
        'Upload a resume and wait for it to be parsed before starting an interview',
      );

    if (user.role !== 'admin') {
      const used = await interviewsRepository.countCreatedSince(userId, startOfMonthUtc());
      if (used >= config.FREE_INTERVIEWS_PER_MONTH) {
        throw Errors.quotaExceeded(
          `Monthly limit of ${config.FREE_INTERVIEWS_PER_MONTH} interviews reached`,
        );
      }
    }

    const durationSec = input.durationMin * 60;
    const plan = buildPlan({
      profile,
      role,
      level,
      companyType,
      durationSec,
      skillScores: await progressService.latestSkillScores(userId),
    });

    const interview = await interviewsRepository.create({
      userId: user._id,
      profileId: profile._id,
      role,
      level,
      companyType,
      mode: input.mode,
      status: 'created',
      durationSec,
      plan,
      state: {
        phase: 'created',
        currentObjectiveIdx: 0,
        difficulty: plan[0]!.startDifficulty,
        followUpsOnThread: 0,
        hintsOnThread: 0,
        objectiveStartedAtSec: 0,
        questionsAsked: 0,
        strengths: [],
        weaknesses: [],
        coveredConcepts: [],
        runningScores: {},
      },
    });
    return toPublicInterview(interview);
  },

  async get(userId: string, id: string) {
    return view(await getOwned(userId, id));
  },

  /** Starts the interview and returns the first question (idempotent). */
  async start(userId: string, id: string) {
    return view(await interviewLoop.start(await getOwned(userId, id)));
  },

  /** Scores an answer and returns the next question, or the closing message. */
  async submitAnswer(userId: string, id: string, input: SubmitAnswerInput) {
    const { interview, closingMessage } = await interviewLoop.submitAnswer(
      await getOwned(userId, id),
      input.seq,
      input.answerText,
    );
    return { ...(await view(interview)), closingMessage };
  },

  async listTurns(userId: string, id: string, cursor: string | undefined, limit: number) {
    const interview = await getOwned(userId, id);
    const afterSeq = cursor ? Number.parseInt(cursor, 10) : 0;
    if (!Number.isFinite(afterSeq) || afterSeq < 0) throw Errors.badRequest('Invalid cursor');

    const turns = await interviewsRepository.listTurns(id, afterSeq, limit + 1);
    const page = turns.slice(0, limit);
    const result: Page<ReturnType<typeof toPublicTurn>> = {
      items: page.map((t) => toPublicTurn(t, interview.status === 'ended')),
      nextCursor: turns.length > limit ? String(page[page.length - 1]!.seq) : null,
    };
    return result;
  },

  /** Ends the interview and enqueues its report atomically. Idempotent. */
  async end(userId: string, id: string) {
    const current = await getOwned(userId, id);
    if (current.status === 'ended' || current.status === 'abandoned')
      return toPublicInterview(current);

    const ended = await withTransaction(async (session) => {
      const doc = await interviewsRepository.end(id, userId, 'user_ended', session);
      if (doc) await jobQueue.enqueue('report.generate', { interviewId: id }, { session });
      return doc;
    });
    // `null` means a concurrent request ended it first; return the current state.
    return toPublicInterview(ended ?? (await getOwned(userId, id)));
  },

  /** Live voice call: rooms, a bot and browser credentials (safe to call again to reconnect). */
  async join(userId: string, id: string) {
    return joinCall(await getOwned(userId, id));
  },

  async getReport(userId: string, id: string) {
    const interview = await getOwned(userId, id);
    if (interview.status !== 'ended') throw Errors.conflict('The interview has not ended yet');
    return reportsService.getState(interview);
  },
};

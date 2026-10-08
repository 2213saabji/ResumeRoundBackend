import { withTransaction } from '../../common/db.js';
import { AppError, Errors } from '../../common/errors.js';
import { logger } from '../../common/logger.js';
import { getAiGateway } from '../ai/gateway.js';
import type { AnswerEvaluation, QuestionSpec } from '../ai/schemas.js';
import type { PastTurn, QuestionRequest } from '../ai/types.js';
import { updateRunningScore } from '../evaluations/scoring.js';
import { jobQueue } from '../jobs/queue.js';
import { aiContext, planOf } from './ai-context.js';
import { isRepeatQuestion } from './engine/question-repeat.js';
import {
  decide,
  moveOn,
  type ControllerState,
  type DecideInput,
  type Decision,
} from './engine/turn-controller.js';
import type { PlanObjective } from './engine/types.js';
import type { Interview, InterviewTurn } from './model.js';
import { interviewsRepository, type TurnEvaluationRecord } from './repository.js';

/**
 * The text interview loop (MVP-2): `start` asks the first question, every `submitAnswer`
 * scores the answer, lets the turn controller decide, and asks the next question - all inside
 * the request, so the client never polls. The live-call bot (MVP-4) will reuse these steps.
 */

const CLOSING_COMPLETED =
  "That's all from my side. Thanks for walking me through your work - your report will be ready shortly.";
const CLOSING_TIMEOUT =
  "We're out of time, so let's stop here. Thanks for your answers - your report will be ready shortly.";

const RECENT_TURNS = 3;
const MAX_COVERED_CONCEPTS = 100;
const MAX_STRENGTHS = 20;

export function elapsedSec(i: Interview, now = Date.now()): number {
  return i.startedAt ? Math.max(0, Math.floor((now - i.startedAt.getTime()) / 1000)) : 0;
}

export function toProgress(i: Interview) {
  if (!i.startedAt) return null;
  const elapsed = elapsedSec(i);
  return {
    objectiveIdx: i.state.currentObjectiveIdx,
    objectiveCount: i.plan.length,
    objectiveKind: i.plan[i.state.currentObjectiveIdx]?.kind ?? null,
    questionsAsked: i.state.questionsAsked,
    elapsedSec: Math.min(elapsed, i.durationSec),
    remainingSec: Math.max(0, i.durationSec - elapsed),
  };
}

export function toPublicCurrentTurn(t: InterviewTurn) {
  return {
    seq: t.seq,
    objectiveIdx: t.objectiveIdx,
    objectiveKind: t.objectiveKind ?? null,
    questionText: t.questionText,
    isFollowUp: t.isFollowUp ?? false,
    askedAt: t.askedAt ?? null,
  };
}

/** The open question of a live interview, or null. */
export async function findCurrentTurn(i: Interview): Promise<InterviewTurn | null> {
  if (i.status !== 'in_progress' || i.state.questionsAsked < 1) return null;
  return interviewsRepository.getTurn(i._id.toString(), i.state.questionsAsked);
}

function controllerState(i: Interview): ControllerState {
  return {
    currentObjectiveIdx: i.state.currentObjectiveIdx,
    difficulty: i.state.difficulty,
    followUpsOnThread: i.state.followUpsOnThread,
    hintsOnThread: i.state.hintsOnThread,
    objectiveStartedAtSec: i.state.objectiveStartedAtSec,
  };
}

/** AI failures surface as 503: the client retries the same request, which is safe. */
async function callAi<T>(task: string, interviewId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    logger.error({ err, task, interviewId }, 'AI call failed during interview turn');
    throw Errors.unavailable('The interviewer is temporarily unavailable. Please retry.');
  }
}

function isConflict(err: unknown): boolean {
  return (
    (err instanceof AppError && err.status === 409) ||
    (typeof err === 'object' && err !== null && (err as { code?: number }).code === 11000)
  );
}

function questionTurn(
  i: Interview,
  seq: number,
  objectiveIdx: number,
  objective: PlanObjective,
  move: QuestionRequest['move'],
  difficulty: number,
  spec: QuestionSpec,
) {
  return {
    interviewId: i._id,
    seq,
    objectiveIdx,
    objectiveKind: objective.kind,
    move,
    isFollowUp: move !== 'opening' && move !== 'next_objective',
    questionText: spec.question,
    spec: { expectedConcepts: spec.expectedConcepts, goodAnswer: spec.goodAnswer },
    difficulty,
    askedAt: new Date(),
  };
}

function toEvaluationRecord(e: AnswerEvaluation): TurnEvaluationRecord {
  return {
    dimensionScores: Object.fromEntries(
      Object.entries(e.dimensionScores).filter(
        (entry): entry is [string, number] => entry[1] !== null,
      ),
    ),
    overall: e.overall,
    confidence: e.confidence,
    isVague: e.isVague,
    evidence: e.evidence,
    coveredConcepts: e.coveredConcepts,
    missedConcepts: e.missedConcepts,
    strengths: e.strengths,
    weaknesses: e.weaknesses,
  };
}

function mergeUnique(existing: string[], added: string[], max: number): string[] {
  const seen = new Set(existing.map((x) => x.toLowerCase()));
  const out = [...existing];
  for (const item of added) {
    if (!seen.has(item.toLowerCase())) {
      seen.add(item.toLowerCase());
      out.push(item);
    }
  }
  return out.slice(-max);
}

function updatedRunningScores(
  previous: Record<string, number> | undefined,
  scores: AnswerEvaluation['dimensionScores'],
): Record<string, number> {
  const next = { ...(previous ?? {}) };
  for (const [dimension, score] of Object.entries(scores)) {
    if (score !== null) next[dimension] = updateRunningScore(next[dimension], score);
  }
  return next;
}

function toPastTurns(turns: InterviewTurn[]): PastTurn[] {
  return turns.map((t) => ({ question: t.questionText, answer: t.answerText ?? null }));
}

export const interviewLoop = {
  /**
   * Starts the interview and asks the first question. Idempotent: an interview already in
   * progress is returned as is. Returns the fresh interview document.
   */
  async start(interview: Interview): Promise<Interview> {
    const id = interview._id.toString();
    if (interview.status === 'in_progress') return interview;
    if (interview.status !== 'created') throw Errors.conflict('This interview has already ended');

    const objective = planOf(interview)[0];
    if (!objective) throw Errors.conflict('This interview has no plan');

    const context = await aiContext(interview);
    const spec = await callAi('generateQuestion', id, () =>
      getAiGateway().generateQuestion(
        {
          context,
          objective,
          move: 'opening',
          difficulty: interview.state.difficulty,
          recentTurns: [],
          coveredConcepts: [],
          focusConcept: null,
          vagueClaim: null,
          askedQuestions: [],
        },
        { userId: interview.userId.toString(), interviewId: id },
      ),
    );

    try {
      await withTransaction(async (session) => {
        await interviewsRepository.checkpoint(
          id,
          interview.version,
          {
            status: 'in_progress',
            // The clock starts when the first question is ready, not when the request arrived.
            startedAt: new Date(),
            state: {
              ...interview.state,
              phase: 'listening',
              currentObjectiveIdx: 0,
              followUpsOnThread: 0,
              hintsOnThread: 0,
              objectiveStartedAtSec: 0,
              questionsAsked: 1,
            },
          },
          { expectedStatus: 'created', session },
        );
        await interviewsRepository.insertTurn(
          questionTurn(interview, 1, 0, objective, 'opening', interview.state.difficulty, spec),
          session,
        );
      });
    } catch (err) {
      // A concurrent `start` (double click, second tab) won the race; return its result.
      if (!isConflict(err)) throw err;
    }
    return reload(interview);
  },

  /**
   * Scores the answer to question `seq`, decides the next move and asks the next question, or
   * ends the interview. Safe to retry: a replay of an already-processed answer returns the
   * current state, and an answer whose processing failed is processed again.
   */
  async submitAnswer(
    interview: Interview,
    seq: number,
    answerText: string,
  ): Promise<{ interview: Interview; closingMessage: string | null }> {
    const id = interview._id.toString();
    if (interview.status === 'created') throw Errors.conflict('Start the interview first');
    // An ended interview may still be a duplicate of the final answer: replay or reject.
    if (interview.status !== 'in_progress') return replayOrReject(interview, seq, answerText);

    const currentSeq = interview.state.questionsAsked;
    if (seq !== currentSeq) return replayOrReject(interview, seq, answerText);

    const turn = await interviewsRepository.getTurn(id, seq);
    if (!turn) throw Errors.conflict('The current question could not be found');
    if (!(await interviewsRepository.saveAnswer(id, seq, answerText))) {
      return replayOrReject(await reload(interview), seq, answerText);
    }

    const started = Date.now();
    const plan = planOf(interview);
    const objective = plan[turn.objectiveIdx];
    if (!objective)
      throw Errors.conflict('This interview has no objective for the current question');
    const aiCtx = { userId: interview.userId.toString(), interviewId: id };
    const [context, previous] = await Promise.all([
      aiContext(interview),
      interviewsRepository.turnsBefore(id, seq, RECENT_TURNS),
    ]);

    const evaluation = await callAi('evaluateAnswer', id, () =>
      getAiGateway().evaluateAnswer(
        {
          context,
          objective,
          difficulty: turn.difficulty ?? interview.state.difficulty,
          question: turn.questionText,
          expectedConcepts: turn.spec?.expectedConcepts ?? [],
          goodAnswer: turn.spec?.goodAnswer ?? '',
          answer: answerText,
          recentTurns: toPastTurns(previous),
        },
        aiCtx,
      ),
    );

    const elapsed = elapsedSec(interview);
    const decideInput: DecideInput = {
      state: controllerState(interview),
      plan,
      level: interview.level,
      elapsedSec: elapsed,
      totalBudgetSec: interview.durationSec,
      evaluation: {
        score: evaluation.overall,
        confidence: evaluation.confidence,
        isVague: evaluation.isVague,
        suggestedMove: evaluation.suggestedMove,
        suggestedDifficultyChange: evaluation.suggestedDifficultyChange,
        suggestionReason: evaluation.reason,
      },
    };
    let decision = decide(decideInput);

    const coveredConcepts = mergeUnique(
      interview.state.coveredConcepts ?? [],
      evaluation.coveredConcepts,
      MAX_COVERED_CONCEPTS,
    );

    // Write the next question before persisting anything, so a repeat can still change course.
    let spec: QuestionSpec | null = null;
    if (decision.move !== 'wrap_up') {
      const askedQuestions = await interviewsRepository.questionTexts(id);
      const ask = (d: Decision, avoidRepeat: boolean) =>
        callAi('generateQuestion', id, () =>
          getAiGateway().generateQuestion(
            {
              context,
              objective: plan[d.nextState.currentObjectiveIdx]!,
              move: d.move,
              difficulty: d.nextState.difficulty,
              recentTurns: [
                ...toPastTurns(previous),
                { question: turn.questionText, answer: answerText },
              ].slice(-RECENT_TURNS),
              coveredConcepts,
              focusConcept: evaluation.focusConcept,
              vagueClaim: evaluation.vagueClaim,
              askedQuestions,
              avoidRepeat,
            },
            aiCtx,
          ),
        );

      spec = await ask(decision, false);
      if (isRepeatQuestion(spec.question, askedQuestions)) {
        spec = await ask(decision, true);
      }
      if (isRepeatQuestion(spec.question, askedQuestions)) {
        // Still repeating: this thread has nothing new to offer, so leave it.
        logger.warn({ interviewId: id, seq, move: decision.move }, 'repeated question; moving on');
        decision = moveOn(decideInput, 'interviewer repeated an earlier question; moving on');
        spec = decision.move === 'wrap_up' ? null : await ask(decision, true);
      }
    }

    const nextState = {
      ...interview.state,
      ...decision.nextState,
      coveredConcepts,
      strengths: mergeUnique(interview.state.strengths, evaluation.strengths, MAX_STRENGTHS),
      weaknesses: mergeUnique(interview.state.weaknesses, evaluation.weaknesses, MAX_STRENGTHS),
      runningScores: updatedRunningScores(
        interview.state.runningScores as Record<string, number> | undefined,
        evaluation.dimensionScores,
      ),
    };
    const turnResult = {
      evaluation: toEvaluationRecord(evaluation),
      decision: { move: decision.move, reason: decision.reason },
    };

    try {
      if (decision.move === 'wrap_up' || !spec) {
        const timedOut = elapsed >= interview.durationSec;
        await withTransaction(async (session) => {
          await interviewsRepository.recordEvaluation(
            id,
            seq,
            { ...turnResult, latencyMs: Date.now() - started },
            session,
          );
          await interviewsRepository.checkpoint(
            id,
            interview.version,
            {
              status: 'ended',
              endedAt: new Date(),
              endReason: timedOut ? 'timeout' : 'completed',
              reportStatus: 'pending',
              state: { ...nextState, phase: 'ended' },
            },
            { expectedStatus: 'in_progress', session },
          );
          await jobQueue.enqueue('report.generate', { interviewId: id }, { session });
        });
        return {
          interview: await reload(interview),
          closingMessage: timedOut ? CLOSING_TIMEOUT : CLOSING_COMPLETED,
        };
      }

      const nextQuestion = spec;
      const nextObjective = plan[decision.nextState.currentObjectiveIdx]!;
      await withTransaction(async (session) => {
        await interviewsRepository.recordEvaluation(
          id,
          seq,
          { ...turnResult, latencyMs: Date.now() - started },
          session,
        );
        await interviewsRepository.insertTurn(
          questionTurn(
            interview,
            seq + 1,
            decision.nextState.currentObjectiveIdx,
            nextObjective,
            decision.move,
            decision.nextState.difficulty,
            nextQuestion,
          ),
          session,
        );
        await interviewsRepository.checkpoint(
          id,
          interview.version,
          { state: { ...nextState, phase: 'listening', questionsAsked: seq + 1 } },
          { expectedStatus: 'in_progress', session },
        );
      });
    } catch (err) {
      // Another request processed this answer first, or the user ended the interview meanwhile.
      if (!isConflict(err)) throw err;
      return replayOrReject(await reload(interview), seq, answerText);
    }

    return { interview: await reload(interview), closingMessage: null };
  },
};

async function reload(i: Interview): Promise<Interview> {
  const fresh = await interviewsRepository.findForUser(i._id.toString(), i.userId.toString());
  if (!fresh) throw Errors.notFound('Interview');
  return fresh;
}

/**
 * A request for a question that is no longer current: if it is a duplicate of an answer that
 * was already processed (double click, network retry), return the current state; otherwise 409.
 */
async function replayOrReject(
  interview: Interview,
  seq: number,
  answerText: string,
): Promise<{ interview: Interview; closingMessage: string | null }> {
  const id = interview._id.toString();
  if (seq < interview.state.questionsAsked || interview.status === 'ended') {
    const answered = await interviewsRepository.getTurn(id, seq);
    if (answered?.answerText === answerText && answered.decision?.move) {
      return { interview, closingMessage: null };
    }
  }
  if (interview.status !== 'in_progress') {
    throw Errors.conflict('This interview has already ended');
  }
  throw new AppError(409, 'CONFLICT', 'This question is no longer the current one', {
    currentSeq: interview.state.questionsAsked,
  });
}

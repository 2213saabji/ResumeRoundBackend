import { LEVEL_DIFFICULTY_BAND, type Level } from '../../../common/domain.js';
import type { Move, PlanObjective } from './types.js';

/** Controller rules (see PRD "Controller rules"). Tuned here, nowhere else. */
export const RULES = {
  maxFollowUpsPerThread: 3,
  maxFollowUpsCoreDeepDive: 5,
  maxDifficultyStep: 2,
  minEvaluatorConfidence: 0.5,
  strongAnswerScore: 8,
  weakAnswerScore: 3,
  scenarioRevealMinScore: 5,
  maxHintsPerThread: 1,
} as const;

export interface ControllerState {
  currentObjectiveIdx: number;
  difficulty: number;
  followUpsOnThread: number;
  hintsOnThread: number;
  /** Interview-elapsed seconds when the current objective started. */
  objectiveStartedAtSec: number;
}

export interface TurnEvaluation {
  /** Overall answer quality, 0-10. */
  score: number;
  /** Evaluator's confidence in its own score, 0-1. */
  confidence: number;
  /** The answer made claims without specifics (e.g. "we optimised the queries"). */
  isVague: boolean;
  /** Scenario questions only: stages of information not yet revealed. */
  scenarioStagesRemaining?: number;
}

export interface DecideInput {
  state: ControllerState;
  plan: PlanObjective[];
  level: Level;
  elapsedSec: number;
  totalBudgetSec: number;
  evaluation: TurnEvaluation;
}

export interface Decision {
  move: Move;
  reason: string;
  nextState: ControllerState;
}

/** Moves at most ±maxDifficultyStep from `current` towards `target`, inside the level band. */
export function stepDifficulty(current: number, target: number, level: Level): number {
  const band = LEVEL_DIFFICULTY_BAND[level];
  const step = Math.max(
    -RULES.maxDifficultyStep,
    Math.min(RULES.maxDifficultyStep, target - current),
  );
  return Math.max(band.min, Math.min(band.max, current + step));
}

/**
 * Picks the next move after an evaluated answer. Deterministic and LLM-free: the LLM only
 * phrases the question this decision asks for.
 */
export function decide(input: DecideInput): Decision {
  const { state, plan, level, evaluation } = input;
  const objective = plan[state.currentObjectiveIdx];
  if (!objective) return wrapUp(state, 'plan exhausted');

  if (input.elapsedSec >= input.totalBudgetSec)
    return wrapUp(state, 'interview time budget reached');

  const followUp = (move: Move, reason: string, difficulty = state.difficulty): Decision => ({
    move,
    reason,
    nextState: {
      ...state,
      difficulty: stepDifficulty(state.difficulty, difficulty, level),
      followUpsOnThread: state.followUpsOnThread + 1,
      hintsOnThread: state.hintsOnThread + (move === 'hint' ? 1 : 0),
    },
  });

  const advance = (reason: string, difficultyBias = 0): Decision => {
    const nextIdx = state.currentObjectiveIdx + 1;
    const next = plan[nextIdx];
    if (!next) return wrapUp(state, `${reason}; last objective done`);
    return {
      move: 'next_objective',
      reason,
      nextState: {
        currentObjectiveIdx: nextIdx,
        difficulty: stepDifficulty(state.difficulty, next.startDifficulty + difficultyBias, level),
        followUpsOnThread: 0,
        hintsOnThread: 0,
        objectiveStartedAtSec: input.elapsedSec,
      },
    };
  };

  const maxFollowUps = objective.isCoreDeepDive
    ? RULES.maxFollowUpsCoreDeepDive
    : RULES.maxFollowUpsPerThread;
  const threadExhausted = state.followUpsOnThread >= maxFollowUps;

  if (input.elapsedSec - state.objectiveStartedAtSec >= objective.timeBudgetSec) {
    return advance('objective time budget reached');
  }
  if (evaluation.confidence < RULES.minEvaluatorConfidence && !threadExhausted) {
    return followUp('clarify', 'evaluator confidence too low to score; ask a clarifying question');
  }
  if (threadExhausted) return advance(`max ${maxFollowUps} follow-ups on this thread`);

  if (evaluation.isVague)
    return followUp('challenge_vague', 'answer made claims without specifics');

  if (
    (evaluation.scenarioStagesRemaining ?? 0) > 0 &&
    evaluation.score >= RULES.scenarioRevealMinScore
  ) {
    return followUp('reveal_scenario_info', 'scenario progressing; reveal the next stage');
  }
  if (evaluation.score >= RULES.strongAnswerScore) {
    return followUp(
      'raise_difficulty',
      'strong answer',
      state.difficulty + RULES.maxDifficultyStep,
    );
  }
  if (evaluation.score <= RULES.weakAnswerScore) {
    return state.hintsOnThread < RULES.maxHintsPerThread
      ? followUp('hint', 'weak answer; offer a hint', state.difficulty - 1)
      : advance('still weak after a hint', -1);
  }
  return followUp('deepen', 'solid answer; probe deeper on the same thread');
}

function wrapUp(state: ControllerState, reason: string): Decision {
  return { move: 'wrap_up', reason, nextState: { ...state } };
}

import type { CompanyType, Level, TargetRole } from '../../common/domain.js';
import type { Move, PlanObjective } from '../interviews/engine/types.js';
import type { AnswerEvaluation, QuestionSpec, ReportNarrative, ResumeAnalysis } from './schemas.js';

export interface AiCallContext {
  userId?: string;
  interviewId?: string;
}

/**
 * A failed AI call. `retryable` is false when sending the same request again cannot help
 * (safety refusal, invalid request, bad credentials).
 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** Who is being interviewed, for what. Stable for a whole interview. */
export interface InterviewAiContext {
  role: TargetRole;
  level: Level;
  companyType: CompanyType;
  candidate: {
    experienceYears: number;
    seniority: string;
    domain: string | null;
    skills: Record<string, string[]>;
    projects: {
      name: string;
      technologies: string[];
      description: string;
      scaleSignals: string[];
    }[];
  };
}

export interface PastTurn {
  question: string;
  answer: string | null;
}

/** `opening` is the first question of the interview; every other value is a controller move. */
export type QuestionMove = Move | 'opening';

export interface QuestionRequest {
  context: InterviewAiContext;
  objective: PlanObjective;
  move: QuestionMove;
  difficulty: number;
  /** Up to the last 3 turns, oldest first. */
  recentTurns: PastTurn[];
  coveredConcepts: string[];
  focusConcept: string | null;
  vagueClaim: string | null;
  /** Every question asked so far in this interview, oldest first; never repeat one. */
  askedQuestions: string[];
  /** Set when the previous attempt repeated an earlier question. */
  avoidRepeat?: boolean;
}

export interface EvaluationRequest {
  context: InterviewAiContext;
  objective: PlanObjective;
  difficulty: number;
  question: string;
  expectedConcepts: string[];
  goodAnswer: string;
  answer: string;
  /** Turns before this question, oldest first. */
  recentTurns: PastTurn[];
}

export interface ReportTurn {
  objectiveKind: string;
  topic: string;
  question: string;
  answer: string;
  overall: number;
  missedConcepts: string[];
  evidence: { dimension: string; quote: string; note: string }[];
}

export interface ReportRequest {
  context: InterviewAiContext;
  endReason: string;
  /** Computed in code from the turn evaluations; the narrative must agree with them. */
  dimensionScores: Record<string, number>;
  overall: number;
  turns: ReportTurn[];
}

/**
 * Single entry point for every AI call; providers are swapped by config (AI_PROVIDER).
 * Later phases add: embed, transcribe (stream), speak (stream).
 */
export interface AiGateway {
  readonly provider: string;
  analyzeResume(resumeText: string, ctx: AiCallContext): Promise<ResumeAnalysis>;
  /** Writes the next question for a move the turn controller already decided. */
  generateQuestion(req: QuestionRequest, ctx: AiCallContext): Promise<QuestionSpec>;
  /** Scores one answer against its question spec and suggests the next move. */
  evaluateAnswer(req: EvaluationRequest, ctx: AiCallContext): Promise<AnswerEvaluation>;
  /** Writes the report narrative (strengths, gaps, feedback, what to study) for scores given. */
  generateReport(req: ReportRequest, ctx: AiCallContext): Promise<ReportNarrative>;
}

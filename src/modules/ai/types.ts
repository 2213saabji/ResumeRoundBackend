import type { ResumeAnalysis } from './schemas.js';

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

/**
 * Single entry point for every AI call; providers are swapped by config (AI_PROVIDER).
 * Later phases add: phraseQuestion (stream), evaluateAnswer, suggestFollowUp,
 * generateReport, embed, transcribe (stream), speak (stream).
 */
export interface AiGateway {
  readonly provider: string;
  analyzeResume(resumeText: string, ctx: AiCallContext): Promise<ResumeAnalysis>;
}

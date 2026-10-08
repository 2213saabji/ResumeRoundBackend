import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import type { z } from 'zod';
import { config } from '../../../common/config.js';
import { recordUsage } from '../cost-meter.js';
import { EVALUATOR_SYSTEM, renderEvaluationRequest } from '../prompts/evaluator.js';
import { dataBlock } from '../prompts/format.js';
import { INTERVIEWER_SYSTEM, renderQuestionRequest } from '../prompts/interviewer.js';
import { REPORT_WRITER_SYSTEM, renderReportRequest } from '../prompts/report-writer.js';
import { RESUME_ANALYZER_SYSTEM } from '../prompts/resume-analyzer.js';
import {
  answerEvaluationSchema,
  normalizeAnswerEvaluation,
  normalizeQuestionSpec,
  normalizeReportNarrative,
  normalizeResumeAnalysis,
  questionSpecSchema,
  reportNarrativeSchema,
  resumeAnalysisSchema,
  type AnswerEvaluation,
  type QuestionSpec,
  type ReportNarrative,
  type ResumeAnalysis,
} from '../schemas.js';
import {
  AiError,
  type AiCallContext,
  type AiGateway,
  type EvaluationRequest,
  type QuestionRequest,
  type ReportRequest,
} from '../types.js';

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

function supportsEffort(model: string): boolean {
  return !model.startsWith('claude-haiku');
}

function toAiError(err: unknown): unknown {
  if (
    err instanceof Anthropic.BadRequestError ||
    err instanceof Anthropic.AuthenticationError ||
    err instanceof Anthropic.PermissionDeniedError ||
    err instanceof Anthropic.NotFoundError
  ) {
    return new AiError(`Anthropic request rejected (${err.status}): ${err.message}`, false);
  }
  // Rate limits, 5xx and connection errors are retried by the SDK, then by the caller.
  return err;
}

interface StructuredCall<S extends z.ZodType> {
  task: string;
  model: string;
  schema: S;
  /** Byte-stable system prompt; cached by the provider. */
  system: string;
  user: string;
  maxTokens: number;
  effort?: 'low' | 'medium' | 'high';
  ctx: AiCallContext;
}

export class AnthropicProvider implements AiGateway {
  readonly provider = 'anthropic';
  private readonly client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 2 });

  /** One structured-output call: cached system prompt, zod-validated JSON, cost metering. */
  private async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    const started = Date.now();
    let response;
    try {
      response = await this.client.beta.messages.parse({
        model: call.model,
        max_tokens: call.maxTokens,
        ...(FALLBACK_MODELS.has(call.model)
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
        output_config: {
          format: betaZodOutputFormat(call.schema),
          ...(call.effort && supportsEffort(call.model) ? { effort: call.effort } : {}),
        },
        system: [{ type: 'text', text: call.system, cache_control: { type: 'ephemeral' } }],
        messages: [{ role: 'user', content: call.user }],
      });
    } catch (err) {
      throw toAiError(err);
    }

    recordUsage({
      task: call.task,
      provider: this.provider,
      model: response.model,
      userId: call.ctx.userId,
      interviewId: call.ctx.interviewId,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
    });

    if (response.stop_reason === 'refusal') {
      throw new AiError(`The AI model declined the ${call.task} request`, false);
    }
    if (!response.parsed_output) {
      throw new AiError(
        `${call.task} returned no valid output (stop_reason=${response.stop_reason})`,
        true,
      );
    }
    return response.parsed_output as z.infer<S>;
  }

  async analyzeResume(resumeText: string, ctx: AiCallContext): Promise<ResumeAnalysis> {
    // Mid tier: runs once per resume and the result is stored, so accuracy beats latency.
    const out = await this.structured({
      task: 'analyzeResume',
      model: config.AI_MODEL_MID,
      schema: resumeAnalysisSchema,
      system: RESUME_ANALYZER_SYSTEM,
      user: dataBlock('resume', resumeText),
      maxTokens: 16_000,
      effort: 'low',
      ctx,
    });
    return normalizeResumeAnalysis(out);
  }

  async generateQuestion(req: QuestionRequest, ctx: AiCallContext): Promise<QuestionSpec> {
    // Small tier: short output on the latency-critical path of every turn.
    const out = await this.structured({
      task: 'generateQuestion',
      model: config.AI_MODEL_SMALL,
      schema: questionSpecSchema,
      system: INTERVIEWER_SYSTEM,
      user: renderQuestionRequest(req),
      maxTokens: 1_500,
      ctx,
    });
    return normalizeQuestionSpec(out);
  }

  async evaluateAnswer(req: EvaluationRequest, ctx: AiCallContext): Promise<AnswerEvaluation> {
    // Mid tier: structured scoring against the question's checklist.
    const out = await this.structured({
      task: 'evaluateAnswer',
      model: config.AI_MODEL_MID,
      schema: answerEvaluationSchema,
      system: EVALUATOR_SYSTEM,
      user: renderEvaluationRequest(req),
      maxTokens: 8_000,
      effort: 'low',
      ctx,
    });
    return normalizeAnswerEvaluation(out);
  }

  async generateReport(req: ReportRequest, ctx: AiCallContext): Promise<ReportNarrative> {
    // Large tier: runs once per interview and is what the candidate reads, so quality first.
    const out = await this.structured({
      task: 'generateReport',
      model: config.AI_MODEL_LARGE,
      schema: reportNarrativeSchema,
      system: REPORT_WRITER_SYSTEM,
      user: renderReportRequest(req),
      maxTokens: 16_000,
      effort: 'medium',
      ctx,
    });
    return normalizeReportNarrative(out);
  }
}

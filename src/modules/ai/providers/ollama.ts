import { z } from 'zod';
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

export interface OllamaOptions {
  /** e.g. `http://localhost:11434`, a private GPU server, or `https://ollama.com` (cloud). */
  baseUrl: string;
  /** Only for Ollama Cloud; a self-hosted server has no authentication. */
  apiKey?: string;
  models: { small: string; mid: string; large: string };
  /**
   * Context window in tokens, the same for every call: Ollama reloads the model when it
   * changes, and its default (a few thousand tokens) silently cuts long resumes and reports.
   */
  numCtx: number;
  timeoutMs: number;
  /** Record usage in `ai_usage` (off for scripts that run without a database). */
  meter?: boolean;
}

interface StructuredCall<S extends z.ZodType> {
  task: string;
  model: string;
  schema: S;
  system: string;
  user: string;
  maxTokens: number;
  temperature: number;
  ctx: AiCallContext;
}

interface ChatResponse {
  model: string;
  message?: { content?: string };
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

/**
 * Open models served by Ollama (native `/api/chat`). The output is constrained to the task's
 * JSON schema, then validated with zod; small models still produce invalid output now and
 * then, so one invalid reply is retried before giving up. Self-hosted calls are recorded with
 * a cost of 0: the GPU server is a fixed monthly cost, not a per-call one.
 */
export class OllamaProvider implements AiGateway {
  readonly provider = 'ollama';
  private readonly jsonSchemas = new Map<z.ZodType, unknown>();

  constructor(private readonly opts: OllamaOptions) {}

  private jsonSchema(schema: z.ZodType): unknown {
    let json = this.jsonSchemas.get(schema);
    if (!json) {
      json = z.toJSONSchema(schema);
      this.jsonSchemas.set(schema, json);
    }
    return json;
  }

  private async chat(call: StructuredCall<z.ZodType>): Promise<ChatResponse> {
    let res: Response;
    try {
      res = await fetch(`${this.opts.baseUrl.replace(/\/$/, '')}/api/chat`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.opts.apiKey ? { authorization: `Bearer ${this.opts.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: call.model,
          messages: [
            { role: 'system', content: call.system },
            { role: 'user', content: call.user },
          ],
          format: this.jsonSchema(call.schema),
          stream: false,
          keep_alive: '30m',
          options: {
            temperature: call.temperature,
            num_ctx: this.opts.numCtx,
            num_predict: call.maxTokens,
          },
        }),
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new AiError(`Ollama is unreachable at ${this.opts.baseUrl}: ${String(err)}`, true);
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      if (res.status === 404) {
        throw new AiError(
          `Ollama model "${call.model}" not found; run: ollama pull ${call.model} (${detail})`,
          false,
        );
      }
      throw new AiError(`Ollama HTTP ${res.status}: ${detail}`, res.status >= 500);
    }
    return (await res.json()) as ChatResponse;
  }

  private async structured<S extends z.ZodType>(call: StructuredCall<S>): Promise<z.infer<S>> {
    let lastProblem = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      const response = await this.chat(call);
      if (this.opts.meter ?? true) {
        recordUsage({
          task: call.task,
          provider: this.provider,
          model: response.model || call.model,
          userId: call.ctx.userId,
          interviewId: call.ctx.interviewId,
          inputTokens: response.prompt_eval_count ?? 0,
          outputTokens: response.eval_count ?? 0,
          latencyMs: Date.now() - started,
          costUsd: 0,
        });
      }

      if (response.done_reason === 'length') {
        lastProblem = `output cut off at ${call.maxTokens} tokens`;
        continue;
      }
      let json: unknown;
      try {
        json = JSON.parse(response.message?.content ?? '');
      } catch {
        lastProblem = 'reply was not valid JSON';
        continue;
      }
      const parsed = call.schema.safeParse(json);
      if (parsed.success) return parsed.data;
      lastProblem = `reply did not match the schema: ${parsed.error.issues[0]?.message ?? ''}`;
    }
    throw new AiError(`${call.task} returned no valid output (${lastProblem})`, true);
  }

  async analyzeResume(resumeText: string, ctx: AiCallContext): Promise<ResumeAnalysis> {
    const out = await this.structured({
      task: 'analyzeResume',
      model: this.opts.models.mid,
      schema: resumeAnalysisSchema,
      system: RESUME_ANALYZER_SYSTEM,
      user: dataBlock('resume', resumeText),
      maxTokens: 4_000,
      temperature: 0.1,
      ctx,
    });
    return normalizeResumeAnalysis(out);
  }

  async generateQuestion(req: QuestionRequest, ctx: AiCallContext): Promise<QuestionSpec> {
    // On the latency-critical path of every turn: the small model.
    const out = await this.structured({
      task: 'generateQuestion',
      model: this.opts.models.small,
      schema: questionSpecSchema,
      system: INTERVIEWER_SYSTEM,
      user: renderQuestionRequest(req),
      maxTokens: 1_000,
      temperature: 0.7,
      ctx,
    });
    return normalizeQuestionSpec(out);
  }

  async evaluateAnswer(req: EvaluationRequest, ctx: AiCallContext): Promise<AnswerEvaluation> {
    // Low temperature: the same answer should get the same score.
    const out = await this.structured({
      task: 'evaluateAnswer',
      model: this.opts.models.mid,
      schema: answerEvaluationSchema,
      system: EVALUATOR_SYSTEM,
      user: renderEvaluationRequest(req),
      maxTokens: 2_000,
      temperature: 0.2,
      ctx,
    });
    return normalizeAnswerEvaluation(out);
  }

  async generateReport(req: ReportRequest, ctx: AiCallContext): Promise<ReportNarrative> {
    const out = await this.structured({
      task: 'generateReport',
      model: this.opts.models.large,
      schema: reportNarrativeSchema,
      system: REPORT_WRITER_SYSTEM,
      user: renderReportRequest(req),
      maxTokens: 4_000,
      temperature: 0.4,
      ctx,
    });
    return normalizeReportNarrative(out);
  }
}

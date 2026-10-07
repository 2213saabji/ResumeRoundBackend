import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { config } from '../../../common/config.js';
import { recordUsage } from '../cost-meter.js';
import { RESUME_ANALYZER_SYSTEM } from '../prompts/resume-analyzer.js';
import { normalizeResumeAnalysis, resumeAnalysisSchema, type ResumeAnalysis } from '../schemas.js';
import { AiError, type AiCallContext, type AiGateway } from '../types.js';

/** Models that accept the server-side refusal fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-sonnet-5-5']);

function supportsEffort(model: string): boolean {
  return !model.startsWith('claude-haiku');
}

/** Resume text is untrusted: strip anything that could close the delimiter it is wrapped in. */
function asResumeBlock(text: string): string {
  return `<resume>\n${text.replace(/<\/?resume\b[^>]*>/gi, '')}\n</resume>`;
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
  // Rate limits, 5xx and connection errors are retried by the SDK, then by the job queue.
  return err;
}

export class AnthropicProvider implements AiGateway {
  readonly provider = 'anthropic';
  private readonly client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY, maxRetries: 2 });

  async analyzeResume(resumeText: string, ctx: AiCallContext): Promise<ResumeAnalysis> {
    // Mid tier: runs once per resume and the result is stored, so accuracy beats latency.
    const model = config.AI_MODEL_MID;
    const started = Date.now();

    let response;
    try {
      response = await this.client.beta.messages.parse({
        model,
        max_tokens: 16_000,
        ...(FALLBACK_MODELS.has(model)
          ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
          : {}),
        output_config: {
          format: betaZodOutputFormat(resumeAnalysisSchema),
          ...(supportsEffort(model) ? { effort: 'low' as const } : {}),
        },
        // Stable system prompt first so it is served from the prompt cache.
        system: [
          { type: 'text', text: RESUME_ANALYZER_SYSTEM, cache_control: { type: 'ephemeral' } },
        ],
        messages: [{ role: 'user', content: asResumeBlock(resumeText) }],
      });
    } catch (err) {
      throw toAiError(err);
    }

    recordUsage({
      task: 'analyzeResume',
      provider: this.provider,
      model: response.model,
      userId: ctx.userId,
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: response.usage.cache_creation_input_tokens ?? 0,
      latencyMs: Date.now() - started,
    });

    if (response.stop_reason === 'refusal') {
      throw new AiError('The AI model declined to analyse this resume', false);
    }
    if (!response.parsed_output) {
      throw new AiError(
        `Resume analysis returned no valid output (stop_reason=${response.stop_reason})`,
        true,
      );
    }
    return normalizeResumeAnalysis(response.parsed_output);
  }
}

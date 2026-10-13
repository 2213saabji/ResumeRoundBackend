import { Schema, model, type Types } from 'mongoose';
import { logger } from '../../common/logger.js';

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** USD per million tokens. Update when provider pricing changes. */
const PRICES: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
};

export function computeCostUsd(model: string, usage: TokenUsage): number {
  const price = PRICES[model];
  if (!price) {
    logger.warn({ model }, 'no price configured for model; cost recorded as 0');
    return 0;
  }
  const cost =
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    (usage.cacheReadTokens ?? 0) * price.cacheRead +
    (usage.cacheWriteTokens ?? 0) * price.cacheWrite;
  return Math.round((cost / 1_000_000) * 1e6) / 1e6;
}

const aiUsageSchema = new Schema(
  {
    task: { type: String, required: true },
    provider: { type: String, required: true },
    model: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId },
    interviewId: { type: Schema.Types.ObjectId },
    inputTokens: { type: Number, default: 0 },
    outputTokens: { type: Number, default: 0 },
    cacheReadTokens: { type: Number, default: 0 },
    cacheWriteTokens: { type: Number, default: 0 },
    audioSeconds: { type: Number, default: 0 },
    characters: { type: Number, default: 0 },
    costUsd: { type: Number, required: true },
    latencyMs: { type: Number },
    at: { type: Date, default: () => new Date() },
  },
  { versionKey: false, collection: 'ai_usage' },
);
aiUsageSchema.index({ interviewId: 1, at: 1 });
aiUsageSchema.index({ userId: 1, at: -1 });

export const AiUsageModel = model('AiUsage', aiUsageSchema);

export interface UsageRecord extends TokenUsage {
  task: string;
  provider: string;
  model: string;
  userId?: string | Types.ObjectId;
  interviewId?: string | Types.ObjectId;
  latencyMs?: number;
  /** Set for self-hosted models (0); otherwise computed from PRICES. */
  costUsd?: number;
}

/** Fire-and-forget: metering must never fail the user-facing call. */
export function recordUsage(record: UsageRecord): void {
  const costUsd = record.costUsd ?? computeCostUsd(record.model, record);
  AiUsageModel.create({ ...record, costUsd }).catch((err: unknown) =>
    logger.error({ err, task: record.task }, 'failed to record AI usage'),
  );
}

/**
 * Speech pricing, keyed `provider:model`: USD per minute of audio sent (STT) or per million
 * characters (TTS). Pay-as-you-go list prices, Oct 2026; update when provider pricing changes.
 */
const SPEECH_PRICES: Record<string, { perMinute?: number; perMillionChars?: number }> = {
  'deepgram:nova-3': { perMinute: 0.0077 },
  'deepgram:aura-2': { perMillionChars: 30 },
  'deepgram:aura': { perMillionChars: 15 },
  'google:chirp3-hd': { perMillionChars: 30 },
  'google:neural2': { perMillionChars: 16 },
  'google:wavenet': { perMillionChars: 4 },
  'google:standard': { perMillionChars: 4 },
};

export function computeSpeechCostUsd(
  key: string,
  usage: { audioSeconds?: number; characters?: number },
): number {
  const price = SPEECH_PRICES[key];
  if (!price) {
    logger.warn({ key }, 'no price configured for speech model; cost recorded as 0');
    return 0;
  }
  const cost =
    ((usage.audioSeconds ?? 0) / 60) * (price.perMinute ?? 0) +
    ((usage.characters ?? 0) / 1_000_000) * (price.perMillionChars ?? 0);
  return Math.round(cost * 1e6) / 1e6;
}

export interface SpeechUsageRecord {
  task: 'stt' | 'tts';
  provider: string;
  model: string;
  userId?: string | Types.ObjectId;
  interviewId?: string | Types.ObjectId;
  audioSeconds?: number;
  characters?: number;
  latencyMs?: number;
}

/** Fire-and-forget, like recordUsage. */
export function recordSpeechUsage(record: SpeechUsageRecord): void {
  const costUsd = computeSpeechCostUsd(`${record.provider}:${record.model}`, record);
  AiUsageModel.create({ ...record, costUsd }).catch((err: unknown) =>
    logger.error({ err, task: record.task }, 'failed to record speech usage'),
  );
}

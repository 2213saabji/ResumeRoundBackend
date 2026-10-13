import 'dotenv/config';
import os from 'node:os';
import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v ? v : undefined));

const csv = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  PORT: z.coerce.number().int().positive().default(4000),
  CORS_ORIGINS: csv,

  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  COOKIE_SECURE: bool,
  GOOGLE_CLIENT_ID: optionalString,

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('.storage'),
  S3_BUCKET: optionalString,
  S3_REGION: z.string().default('ap-south-1'),
  S3_ENDPOINT: optionalString,
  S3_FORCE_PATH_STYLE: bool,
  S3_ACCESS_KEY_ID: optionalString,
  S3_SECRET_ACCESS_KEY: optionalString,

  AI_PROVIDER: z.enum(['mock', 'anthropic', 'ollama']).default('mock'),
  ANTHROPIC_API_KEY: optionalString,
  AI_MODEL_SMALL: z.string().default('claude-haiku-4-5'),
  AI_MODEL_MID: z.string().default('claude-sonnet-5-5'),
  AI_MODEL_LARGE: z.string().default('claude-opus-5-5'),
  AI_INTERVIEW_COST_TARGET_USD: z.coerce.number().positive().default(0.75),
  // 127.0.0.1, not localhost: Node may resolve localhost to IPv6 (::1), where Ollama does not listen.
  OLLAMA_URL: z.string().url().default('http://127.0.0.1:11434'),
  OLLAMA_API_KEY: optionalString,
  /** Used for every task unless a per-tier model below is set. */
  OLLAMA_MODEL: z.string().default('qwen2.5:3b'),
  OLLAMA_MODEL_SMALL: optionalString,
  OLLAMA_MODEL_MID: optionalString,
  OLLAMA_MODEL_LARGE: optionalString,
  OLLAMA_NUM_CTX: z.coerce.number().int().min(2048).default(16_384),
  OLLAMA_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  STT_PROVIDER: z.enum(['mock', 'deepgram']).default('mock'),
  DEEPGRAM_API_KEY: optionalString,
  STT_MODEL: z.string().default('nova-3'),
  STT_LANGUAGE: z.string().default('en'),
  STT_ENDPOINTING_MS: z.coerce.number().int().positive().default(500),
  STT_UTTERANCE_END_MS: z.coerce.number().int().min(1000).default(1000),
  TTS_PROVIDER: z.enum(['mock', 'deepgram', 'google']).default('mock'),
  GOOGLE_TTS_API_KEY: optionalString,
  /** Defaults per provider: see DEFAULT_TTS_VOICE. */
  TTS_VOICE: optionalString,
  /** Google only. */
  TTS_SPEAKING_RATE: z.coerce.number().min(0.25).max(2).default(1),

  FREE_INTERVIEWS_PER_MONTH: z.coerce.number().int().nonnegative().default(5),

  WORKER_ID: z.string().default(`${os.hostname()}-${process.pid}`),
  JOB_POLL_MIN_MS: z.coerce.number().int().positive().default(500),
  JOB_POLL_MAX_MS: z.coerce.number().int().positive().default(10_000),
  JOB_CONCURRENCY: z.coerce.number().int().positive().default(4),
  BOT_HEARTBEAT_MS: z.coerce.number().int().positive().default(5_000),
  BOT_CAPACITY: z.coerce.number().int().positive().default(25),
  /** How often the bot looks for new calls and each call re-reads its interview. */
  BOT_POLL_MS: z.coerce.number().int().positive().default(1_000),
  /** Silence after the candidate's last word (beyond the ~1 s utterance end) that ends an answer. */
  BOT_TURN_END_MS: z.coerce.number().int().nonnegative().default(300),
  /** Answers shorter than BOT_MIN_ANSWER_WORDS ("let me think") wait this long instead. */
  BOT_SHORT_ANSWER_WAIT_MS: z.coerce.number().int().nonnegative().default(6_000),
  BOT_MIN_ANSWER_WORDS: z.coerce.number().int().nonnegative().default(4),

  JANUS_HTTP_URL: optionalString,
  JANUS_WS_URL: optionalString,
  JANUS_TOKEN_SECRET: optionalString,
  JANUS_ADMIN_SECRET: optionalString,
  /**
   * Packets (20 ms each) Janus buffers from each candidate before mixing. Home Wi-Fi delivers
   * packets unevenly and Janus drops audio that overflows or underruns this buffer: 2 lost
   * ~10-20% of speech from a home connection, 10 (200 ms) none. Applies to new rooms.
   */
  JANUS_ROOM_PREBUFFER: z.coerce.number().int().min(1).max(50).default(10),
  /**
   * The bot's own buffer. 2 when the bot runs next to Janus (production); ~10 when it runs on a
   * laptop over Wi-Fi (development).
   */
  BOT_JANUS_PREBUFFER: z.coerce.number().int().min(1).max(50).default(2),
  AUDIOBRIDGE_ADMIN_KEY: optionalString,
  TEXTROOM_ADMIN_KEY: optionalString,
  TURN_URLS: csv,
  TURN_SECRET: optionalString,
  TURN_REALM: optionalString,
});

export type Config = z.infer<typeof envSchema>;

function loadConfig(): Config {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment configuration:\n${issues.join('\n')}`);
  }
  const cfg = parsed.data;

  if (cfg.STORAGE_DRIVER === 's3' && !cfg.S3_BUCKET) {
    throw new Error(
      'Invalid environment configuration: S3_BUCKET is required when STORAGE_DRIVER=s3',
    );
  }
  if (cfg.AI_PROVIDER === 'anthropic' && !cfg.ANTHROPIC_API_KEY) {
    throw new Error(
      'Invalid environment configuration: ANTHROPIC_API_KEY is required when AI_PROVIDER=anthropic',
    );
  }
  if (cfg.STT_PROVIDER === 'deepgram' && !cfg.DEEPGRAM_API_KEY) {
    throw new Error(
      'Invalid environment configuration: DEEPGRAM_API_KEY is required when STT_PROVIDER=deepgram',
    );
  }
  if (cfg.TTS_PROVIDER === 'deepgram' && !cfg.DEEPGRAM_API_KEY) {
    throw new Error(
      'Invalid environment configuration: DEEPGRAM_API_KEY is required when TTS_PROVIDER=deepgram',
    );
  }
  if (cfg.TTS_PROVIDER === 'google' && !cfg.GOOGLE_TTS_API_KEY) {
    throw new Error(
      'Invalid environment configuration: GOOGLE_TTS_API_KEY is required when TTS_PROVIDER=google',
    );
  }
  if (cfg.JANUS_HTTP_URL && !cfg.JANUS_TOKEN_SECRET) {
    throw new Error(
      'Invalid environment configuration: JANUS_TOKEN_SECRET is required when JANUS_HTTP_URL is set',
    );
  }
  if (cfg.TURN_URLS.length > 0 && !cfg.TURN_SECRET) {
    throw new Error(
      'Invalid environment configuration: TURN_SECRET is required when TURN_URLS is set',
    );
  }
  if (cfg.COOKIE_SAMESITE === 'none' && !cfg.COOKIE_SECURE) {
    throw new Error(
      'Invalid environment configuration: COOKIE_SAMESITE=none requires COOKIE_SECURE=true',
    );
  }
  return cfg;
}

export const config = loadConfig();

/** Voice used when TTS_VOICE is not set. */
export const DEFAULT_TTS_VOICE = {
  deepgram: 'aura-2-thalia-en',
  google: 'en-IN-Chirp3-HD-Kore',
} as const;
export const isProd = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';

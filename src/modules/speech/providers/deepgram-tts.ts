import { recordSpeechUsage } from '../../ai/cost-meter.js';
import { SPEECH_SAMPLE_RATE, bytesToPcm } from '../audio.js';
import { httpError, retryOnce } from '../http.js';
import { SpeechError, type SynthesisOptions, type TextToSpeech } from '../types.js';

const API = 'https://api.deepgram.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;
/** Deepgram rejects input over 2,000 characters; one sentence is far below that. */
const MAX_INPUT_CHARS = 2_000;

export interface DeepgramTtsOptions {
  apiKey: string;
  /** Aura voice model, e.g. `aura-2-thalia-en`; list them with `speech-probe voices`. */
  voice: string;
  /** Record usage in `ai_usage` (off for scripts that run without a database). */
  meter?: boolean;
}

export interface DeepgramVoice {
  name: string;
  accent?: string;
  tags?: string[];
}

/** Pricing tier from the voice model, e.g. `aura-2-thalia-en` -> `aura-2`. */
export function auraTier(voice: string): string {
  return voice.startsWith('aura-2-') ? 'aura-2' : 'aura';
}

/**
 * Deepgram Aura text-to-speech (REST). Uses the same API key as Deepgram speech-to-text.
 * One request per sentence; callers stream by synthesising sentence by sentence.
 */
export class DeepgramTts implements TextToSpeech {
  readonly provider = 'deepgram';
  readonly voiceId: string;

  constructor(private readonly opts: DeepgramTtsOptions) {
    this.voiceId = `deepgram:${opts.voice}`;
  }

  async *stream(text: string, opts: SynthesisOptions): AsyncGenerator<Int16Array> {
    const input = text.trim();
    if (!input) return;
    if (input.length > MAX_INPUT_CHARS) {
      throw new SpeechError(
        `TTS input is over ${MAX_INPUT_CHARS} characters; split it first`,
        false,
      );
    }

    const url = new URL(`${API}/speak`);
    url.searchParams.set('model', this.opts.voice);
    url.searchParams.set('encoding', 'linear16');
    url.searchParams.set('sample_rate', String(SPEECH_SAMPLE_RATE));
    url.searchParams.set('container', 'none'); // raw PCM, no WAV header

    // Only the request is retried: once audio has been yielded, a retry would repeat it.
    const started = Date.now();
    const res = await retryOnce('Deepgram TTS', async () => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Token ${this.opts.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ text: input }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!r.ok) throw await httpError('Deepgram TTS', r);
      return r;
    });

    // Billed per request, whether or not the audio is played to the end.
    if (this.opts.meter ?? true) {
      recordSpeechUsage({
        task: 'tts',
        provider: 'deepgram',
        model: auraTier(this.opts.voice),
        characters: input.length,
        latencyMs: Date.now() - started,
        userId: opts.ctx.userId,
        interviewId: opts.ctx.interviewId,
      });
    }

    if (!res.body) throw new SpeechError('Deepgram TTS returned no audio', true);
    // Network chunks can split a 16-bit sample; carry the odd byte into the next chunk.
    let carry = Buffer.alloc(0);
    for await (const part of res.body) {
      const bytes = Buffer.concat([carry, part]);
      const even = bytes.length - (bytes.length % 2);
      carry = bytes.subarray(even);
      if (even > 0) yield bytesToPcm(bytes.subarray(0, even));
    }
  }

  /** Aura voices Deepgram offers, from its public model list. */
  async listVoices(): Promise<DeepgramVoice[]> {
    const body = await retryOnce('Deepgram models', async () => {
      const res = await fetch(`${API}/models`, {
        headers: { authorization: `Token ${this.opts.apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await httpError('Deepgram models', res);
      return res.json() as Promise<{
        tts?: { canonical_name?: string; metadata?: { accent?: string; tags?: string[] } }[];
      }>;
    });
    return (body.tts ?? [])
      .filter((m) => m.canonical_name)
      .map((m) => ({
        name: m.canonical_name!,
        accent: m.metadata?.accent,
        tags: m.metadata?.tags,
      }));
  }
}

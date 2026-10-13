import { recordSpeechUsage } from '../../ai/cost-meter.js';
import { SPEECH_SAMPLE_RATE, readWav, resample } from '../audio.js';
import { httpError, retryOnce } from '../http.js';
import { SpeechError, type SynthesisOptions, type TextToSpeech } from '../types.js';

const API = 'https://texttospeech.googleapis.com/v1';
const REQUEST_TIMEOUT_MS = 15_000;
/** Google rejects input over 5,000 bytes; one sentence is far below that. */
const MAX_INPUT_BYTES = 5_000;

export interface GoogleTtsOptions {
  apiKey: string;
  /** e.g. `en-IN-Chirp3-HD-Kore`; list them with `speech-probe voices en-IN`. */
  voice: string;
  /** 1 is normal; 0.25-2. */
  speakingRate: number;
  /** Record usage in `ai_usage` (off for scripts that run without a database). */
  meter?: boolean;
}

/** Pricing tier from the voice name, e.g. `en-IN-Chirp3-HD-Kore` -> `chirp3-hd`. */
export function voiceTier(voice: string): string {
  const v = voice.toLowerCase();
  for (const tier of ['chirp3-hd', 'neural2', 'wavenet', 'standard']) {
    if (v.includes(tier)) return tier;
  }
  return v;
}

/** `en-IN-Chirp3-HD-Kore` -> `en-IN`. */
function languageOf(voice: string): string {
  return voice.split('-').slice(0, 2).join('-');
}

/**
 * Google Cloud Text-to-Speech (REST, API key). One request per sentence; callers stream by
 * synthesising sentence by sentence (see `speakSentences`).
 */
export class GoogleTts implements TextToSpeech {
  readonly provider = 'google';
  readonly voiceId: string;

  constructor(private readonly opts: GoogleTtsOptions) {
    this.voiceId = `google:${opts.voice}:${opts.speakingRate}`;
  }

  /** Google's REST API returns the whole sentence at once, so this yields a single chunk. */
  async *stream(text: string, opts: SynthesisOptions): AsyncGenerator<Int16Array> {
    const input = text.trim();
    if (!input) return;
    if (Buffer.byteLength(input) > MAX_INPUT_BYTES) {
      throw new SpeechError(`TTS input is over ${MAX_INPUT_BYTES} bytes; split it first`, false);
    }

    const started = Date.now();
    const body = await this.request('/text:synthesize', {
      input: { text: input },
      voice: { languageCode: languageOf(this.opts.voice), name: this.opts.voice },
      audioConfig: {
        audioEncoding: 'LINEAR16',
        sampleRateHertz: SPEECH_SAMPLE_RATE,
        ...(this.opts.speakingRate !== 1 ? { speakingRate: this.opts.speakingRate } : {}),
      },
    });
    const audio = (body as { audioContent?: string }).audioContent;
    if (!audio) throw new SpeechError('Google TTS returned no audio', true);

    // LINEAR16 responses carry a WAV header; resample in case the voice ignored the rate.
    const wav = readWav(Buffer.from(audio, 'base64'));
    const pcm = resample(wav.pcm, wav.sampleRate, SPEECH_SAMPLE_RATE);

    if (this.opts.meter ?? true) {
      recordSpeechUsage({
        task: 'tts',
        provider: 'google',
        model: voiceTier(this.opts.voice),
        characters: input.length,
        latencyMs: Date.now() - started,
        userId: opts.ctx.userId,
        interviewId: opts.ctx.interviewId,
      });
    }
    yield pcm;
  }

  /** Voices for a language, e.g. `en-IN`. */
  async listVoices(languageCode: string): Promise<{ name: string; ssmlGender: string }[]> {
    const body = await this.request(`/voices?languageCode=${encodeURIComponent(languageCode)}`);
    return (body as { voices?: { name: string; ssmlGender: string }[] }).voices ?? [];
  }

  private request(path: string, json?: unknown): Promise<unknown> {
    return retryOnce('Google TTS', async () => {
      const res = await fetch(`${API}${path}`, {
        method: json === undefined ? 'GET' : 'POST',
        headers: {
          'x-goog-api-key': this.opts.apiKey,
          ...(json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) throw await httpError('Google TTS', res);
      return res.json();
    });
  }
}

import type { AiCallContext } from '../ai/types.js';

/**
 * A failed speech call. `retryable` is false when trying again cannot help (bad credentials,
 * unknown voice, invalid request).
 */
export class SpeechError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SpeechError';
  }
}

export interface SttStreamOptions {
  /**
   * Words the recogniser should expect (technologies and project names from the resume and the
   * job), e.g. "Kubernetes", "PostgreSQL". Improves accuracy on jargon.
   */
  keyterms?: string[];
  ctx: AiCallContext;
}

export interface SttHandlers {
  /** Interim guess for the words being spoken now; replaced by later partials. */
  onPartial?(text: string): void;
  /** A finished segment; its words will not change. */
  onFinal?(text: string): void;
  /**
   * The speaker paused long enough to end an utterance. `text` joins every final segment since
   * the previous utterance end. The interview bot decides whether this ends the candidate's turn.
   */
  onUtteranceEnd?(text: string): void;
  /**
   * No new words for the utterance-end gap (about 1 s), based on word timings, so every word
   * before it has already been delivered. Fires even when onUtteranceEnd already did. The
   * reliable signal for turn-taking.
   */
  onWordGap?(): void;
  /** Speech began (for barge-in: stop the interviewer talking). */
  onSpeechStarted?(): void;
  /** The stream failed; open a new one to continue. */
  onError?(err: SpeechError): void;
  onClose?(): void;
}

/** One live recognition stream, normally one per interview. */
export interface SttStream {
  /** 16 kHz mono PCM, any frame size (20 ms is typical). */
  write(pcm: Int16Array): void;
  /**
   * Flush: return results for audio sent so far without waiting for more. Resolves once the
   * provider has delivered them (or after a short timeout).
   */
  finalize(): Promise<void>;
  /** Flushes, waits for the last results, then closes and records usage. */
  close(): Promise<void>;
  /** Audio sent to the provider so far (what is billed). */
  readonly audioSeconds: number;
}

export interface SpeechToText {
  readonly provider: string;
  openStream(opts: SttStreamOptions, handlers: SttHandlers): Promise<SttStream>;
}

export interface SynthesisOptions {
  ctx: AiCallContext;
  /**
   * Keep the audio for reuse. Use for text spoken in many interviews (greeting, standard
   * questions, closing); generated questions are unique, so caching them only costs storage.
   */
  cache?: boolean;
}

export interface TextToSpeech {
  readonly provider: string;
  /** Stable for a given voice and settings; part of the cache key. */
  readonly voiceId: string;
  /**
   * Speaks `text` as 16 kHz mono PCM chunks, yielded as soon as the provider sends them, so
   * playback can start before the whole sentence is synthesised.
   */
  stream(text: string, opts: SynthesisOptions): AsyncIterable<Int16Array>;
}

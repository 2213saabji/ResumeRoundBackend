import { SPEECH_SAMPLE_RATE, rmsDbfs } from './audio.js';
import type { SttStream } from './types.js';

export interface SpeechGateOptions {
  /** Frames louder than this count as speech (the spike used -45 dBFS). */
  thresholdDb: number;
  /** Speech must last this long to open the gate, so clicks and breaths stay out. */
  minSpeechMs: number;
  /** Audio kept from just before the gate opens, so the first syllable is not cut. */
  preRollMs: number;
  /**
   * Silence after which the gate closes. Longer than the STT utterance-end gap (1 s), so the
   * provider sees the pause and ends the utterance itself.
   */
  hangoverMs: number;
}

export const DEFAULT_GATE: SpeechGateOptions = {
  thresholdDb: -45,
  minSpeechMs: 60,
  preRollMs: 300,
  hangoverMs: 1_500,
};

const samples = (ms: number) => Math.round((ms * SPEECH_SAMPLE_RATE) / 1000);

/**
 * Energy-based voice gate in front of speech-to-text. Streaming STT bills every second of audio
 * sent, and in an interview the candidate is silent most of the time (listening, thinking), so
 * only speech plus a short margin is sent. Time is counted in samples, so it is deterministic.
 */
export class SpeechGate {
  private readonly opts: SpeechGateOptions;
  private open = false;
  private preRoll: Int16Array[] = [];
  private preRollSamples = 0;
  private voicedRun = 0;
  private silence = 0;
  private totalSamples = 0;
  private sentSamples = 0;

  constructor(opts: Partial<SpeechGateOptions> = {}) {
    this.opts = { ...DEFAULT_GATE, ...opts };
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** Seconds of audio kept away from the provider so far. */
  get savedSeconds(): number {
    return (this.totalSamples - this.sentSamples) / SPEECH_SAMPLE_RATE;
  }

  /**
   * Feeds one frame. Returns the frames to send now, and `ended` when the gate has just closed
   * (time to flush the STT stream).
   */
  push(frame: Int16Array): { send: Int16Array[]; ended: boolean } {
    this.totalSamples += frame.length;
    const voiced = rmsDbfs(frame) > this.opts.thresholdDb;

    if (!this.open) {
      this.preRoll.push(frame);
      this.preRollSamples += frame.length;
      while (this.preRollSamples > samples(this.opts.preRollMs) && this.preRoll.length > 1) {
        this.preRollSamples -= this.preRoll.shift()!.length;
      }
      this.voicedRun = voiced ? this.voicedRun + frame.length : 0;
      if (this.voicedRun < samples(this.opts.minSpeechMs)) return { send: [], ended: false };

      this.open = true;
      this.silence = 0;
      const send = this.preRoll;
      this.preRoll = [];
      this.preRollSamples = 0;
      return this.sent(send, false);
    }

    this.silence = voiced ? 0 : this.silence + frame.length;
    if (this.silence >= samples(this.opts.hangoverMs)) {
      this.open = false;
      this.voicedRun = 0;
      return this.sent([frame], true);
    }
    return this.sent([frame], false);
  }

  private sent(frames: Int16Array[], ended: boolean) {
    for (const f of frames) this.sentSamples += f.length;
    return { send: frames, ended };
  }
}

/** An STT stream that only receives audio while the gate is open. */
export class GatedSttStream implements SttStream {
  readonly gate: SpeechGate;

  constructor(
    private readonly inner: SttStream,
    gateOptions: Partial<SpeechGateOptions> = {},
  ) {
    this.gate = new SpeechGate(gateOptions);
  }

  get audioSeconds(): number {
    return this.inner.audioSeconds;
  }

  write(pcm: Int16Array): void {
    const { send, ended } = this.gate.push(pcm);
    for (const frame of send) this.inner.write(frame);
    if (ended) void this.inner.finalize();
  }

  finalize(): Promise<void> {
    return this.inner.finalize();
  }

  close(): Promise<void> {
    return this.inner.close();
  }
}

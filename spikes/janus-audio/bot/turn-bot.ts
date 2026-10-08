import { FRAME_SAMPLES, createOpus, rmsDbfs, toInt16 } from './audio.js';
import type { AudioLink } from './transport-a.js';

export interface TurnBotOptions {
  /** Spoken reply (48 kHz mono PCM). */
  reply: Int16Array;
  /** Silence after speech before the bot decides the user has finished. */
  hangoverMs: number;
  /** Simulated STT + LLM + TTS time before the reply starts (0 = transport only). */
  thinkMs: number;
  thresholdDb: number;
}

export interface TurnMetrics {
  speechMs: number;
  /** End of detected speech -> first reply frame handed to the transport, minus thinkMs. */
  botMs: number;
  replyMs: number;
  avgEncodeMsPerFrame: number;
}

export const counters = { packetsIn: 0, packetsOut: 0, decodeErrors: 0, turns: 0 };

/**
 * Transport-independent bot: decodes the room audio (Opus), detects the end of speech with an
 * energy VAD, then encodes and paces the reply back in 20 ms frames. Prototypes A and B differ
 * only in the AudioLink (how Opus packets get in and out).
 */
export class TurnBot {
  private readonly decoder = createOpus();
  private readonly encoder = createOpus();
  private speaking = false;
  private inSpeech = false;
  private voicedFrames = 0;
  private speechStart = 0;
  private lastVoiced = 0;
  private readonly timer: NodeJS.Timeout;
  onTurn: (m: TurnMetrics) => void = () => {};

  constructor(
    private readonly link: AudioLink,
    private readonly opts: TurnBotOptions,
  ) {
    link.onOpus((payload) => this.onOpus(payload));
    this.timer = setInterval(() => this.checkEndOfSpeech(), 10);
    // Janus starts sending a plain-RTP participant the mix once it has heard from it.
    this.sendSilence();
  }

  private onOpus(payload: Buffer): void {
    counters.packetsIn++;
    let pcm: Int16Array;
    try {
      pcm = toInt16(this.decoder.decode(payload));
    } catch {
      counters.decodeErrors++;
      return;
    }
    if (this.speaking) return; // half duplex: no barge-in in the spike
    const now = performance.now();
    if (rmsDbfs(pcm) > this.opts.thresholdDb) {
      this.voicedFrames++;
      this.lastVoiced = now;
      if (!this.inSpeech && this.voicedFrames >= 3) {
        this.inSpeech = true;
        this.speechStart = now - 60;
      }
    } else {
      this.voicedFrames = 0;
    }
  }

  private checkEndOfSpeech(): void {
    if (!this.inSpeech || this.speaking) return;
    if (performance.now() - this.lastVoiced < this.opts.hangoverMs) return;
    this.inSpeech = false;
    void this.reply(performance.now());
  }

  private async reply(detectedAt: number): Promise<void> {
    this.speaking = true;
    const speechMs = Math.round(this.lastVoiced - this.speechStart);
    if (this.opts.thinkMs > 0) await sleep(this.opts.thinkMs);

    const { reply } = this.opts;
    const frames = Math.ceil(reply.length / FRAME_SAMPLES);
    const start = performance.now();
    let firstSentAt = 0;
    let encodeMs = 0;
    for (let i = 0; i < frames; i++) {
      const frame = new Int16Array(FRAME_SAMPLES);
      frame.set(reply.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES));
      const t0 = performance.now();
      const opus = this.encoder.encode(Buffer.from(frame.buffer), FRAME_SAMPLES);
      encodeMs += performance.now() - t0;
      this.link.send(opus, FRAME_SAMPLES, i === 0);
      counters.packetsOut++;
      if (i === 0) firstSentAt = performance.now();
      const wait = start + (i + 1) * 20 - performance.now();
      if (wait > 0) await sleep(wait);
    }
    counters.turns++;
    this.onTurn({
      speechMs,
      botMs: Number((firstSentAt - detectedAt - this.opts.thinkMs).toFixed(1)),
      replyMs: frames * 20,
      avgEncodeMsPerFrame: Number((encodeMs / frames).toFixed(3)),
    });
    this.voicedFrames = 0;
    this.speaking = false;
  }

  private sendSilence(): void {
    const silence = new Int16Array(FRAME_SAMPLES);
    this.link.send(
      this.encoder.encode(Buffer.from(silence.buffer), FRAME_SAMPLES),
      FRAME_SAMPLES,
      true,
    );
    counters.packetsOut++;
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.link.close();
    this.encoder.delete();
    this.decoder.delete();
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function botOptionsFromEnv(reply: Int16Array): TurnBotOptions {
  return {
    reply,
    hangoverMs: Number(process.env.HANGOVER_MS ?? 700),
    thinkMs: Number(process.env.THINK_MS ?? 0),
    thresholdDb: Number(process.env.THRESHOLD_DB ?? -45),
  };
}

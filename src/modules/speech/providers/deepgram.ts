import { logger } from '../../../common/logger.js';
import { recordSpeechUsage } from '../../ai/cost-meter.js';
import { SPEECH_SAMPLE_RATE, pcmToBytes } from '../audio.js';
import {
  SpeechError,
  type SpeechToText,
  type SttHandlers,
  type SttStream,
  type SttStreamOptions,
} from '../types.js';

/** The parts of the WebSocket API the stream uses; tests pass a fake. */
export interface SttSocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SttSocket;

const OPEN = 1;
const CONNECT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
/** Deepgram drops a stream after about 10 s without audio; keep it alive while the gate is shut. */
const KEEPALIVE_AFTER_MS = 4_000;
/** Deepgram limits keyterm prompting to about 500 tokens. */
const MAX_KEYTERMS = 50;
/** Longest wait for Deepgram to answer a Finalize (it normally takes one round trip). */
const FINALIZE_TIMEOUT_MS = 800;

export interface DeepgramOptions {
  apiKey: string;
  model: string;
  /** e.g. `en`, `en-IN`, or `multi` for speakers who switch between languages. */
  language: string;
  /** Silence (ms) after which Deepgram marks a result `speech_final`. */
  endpointingMs: number;
  /** Gap (ms) after the last word that triggers an UtteranceEnd message (min 1000). */
  utteranceEndMs: number;
  /** Record usage in `ai_usage` on close (off for scripts that run without a database). */
  meter?: boolean;
  createSocket?: SocketFactory;
}

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  speech_final?: boolean;
  from_finalize?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

/**
 * Deepgram streaming speech-to-text over its WebSocket API. Authenticates with the
 * `token` subprotocol so no custom headers are needed.
 */
export class DeepgramStt implements SpeechToText {
  readonly provider = 'deepgram';
  private readonly createSocket: SocketFactory;

  constructor(private readonly opts: DeepgramOptions) {
    this.createSocket =
      opts.createSocket ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as SttSocket);
  }

  listenUrl(keyterms: string[] = []): string {
    const url = new URL('wss://api.deepgram.com/v1/listen');
    const params: Record<string, string> = {
      model: this.opts.model,
      language: this.opts.language,
      encoding: 'linear16',
      sample_rate: String(SPEECH_SAMPLE_RATE),
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      endpointing: String(this.opts.endpointingMs),
      utterance_end_ms: String(this.opts.utteranceEndMs),
      vad_events: 'true',
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const terms = [...new Set(keyterms.map((t) => t.trim()).filter(Boolean))];
    for (const term of terms.slice(0, MAX_KEYTERMS)) url.searchParams.append('keyterm', term);
    return url.toString();
  }

  async openStream(opts: SttStreamOptions, handlers: SttHandlers): Promise<SttStream> {
    const socket = this.createSocket(this.listenUrl(opts.keyterms), ['token', this.opts.apiKey]);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.close();
        reject(new SpeechError('Deepgram connection timed out', true));
      }, CONNECT_TIMEOUT_MS);
      socket.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timer);
        // The WebSocket API hides the HTTP status: a bad API key looks like a network error.
        reject(new SpeechError('Deepgram connection failed (check DEEPGRAM_API_KEY)', true));
      };
    });
    return new DeepgramStream(socket, handlers, {
      model: this.opts.model,
      meter: this.opts.meter ?? true,
      ctx: opts.ctx,
    });
  }
}

class DeepgramStream implements SttStream {
  audioSeconds = 0;
  private finals: string[] = [];
  private flushWaiters: (() => void)[] = [];
  private lastSentAt = Date.now();
  private closing = false;
  private closed = false;
  private readonly closedPromise: Promise<void>;
  private readonly keepAlive: NodeJS.Timeout;

  constructor(
    private readonly socket: SttSocket,
    private readonly handlers: SttHandlers,
    private readonly info: { model: string; meter: boolean; ctx: SttStreamOptions['ctx'] },
  ) {
    socket.onmessage = (ev) => this.onMessage(ev.data);
    socket.onerror = () => {}; // always followed by close, which reports it
    this.closedPromise = new Promise((resolve) => {
      socket.onclose = (ev) => {
        this.onClosed(ev.code, ev.reason);
        resolve();
      };
    });
    this.keepAlive = setInterval(() => {
      if (Date.now() - this.lastSentAt >= KEEPALIVE_AFTER_MS) this.sendJson({ type: 'KeepAlive' });
    }, 1_000);
  }

  write(pcm: Int16Array): void {
    if (this.closing || this.socket.readyState !== OPEN || pcm.length === 0) return;
    this.socket.send(pcmToBytes(pcm));
    this.audioSeconds += pcm.length / SPEECH_SAMPLE_RATE;
    this.lastSentAt = Date.now();
  }

  finalize(): Promise<void> {
    if (this.socket.readyState !== OPEN) return Promise.resolve();
    this.sendJson({ type: 'Finalize' });
    return new Promise((resolve) => {
      this.flushWaiters.push(resolve);
      setTimeout(resolve, FINALIZE_TIMEOUT_MS).unref();
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    if (!this.closing) {
      this.closing = true;
      this.sendJson({ type: 'CloseStream' });
    }
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, CLOSE_TIMEOUT_MS).unref());
    await Promise.race([this.closedPromise, timeout]);
    if (!this.closed) {
      this.socket.close(1000);
      this.onClosed(1000, 'client timeout');
    }
  }

  private sendJson(msg: Record<string, unknown>): void {
    if (this.socket.readyState !== OPEN) return;
    this.socket.send(JSON.stringify(msg));
    this.lastSentAt = Date.now();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: DeepgramMessage;
    try {
      msg = JSON.parse(data) as DeepgramMessage;
    } catch {
      return;
    }
    if (msg.type === 'Results') {
      const text = msg.channel?.alternatives?.[0]?.transcript?.trim() ?? '';
      if (!msg.is_final) {
        if (text) this.handlers.onPartial?.(text);
        return;
      }
      if (text) {
        this.finals.push(text);
        this.handlers.onFinal?.(text);
      }
      if (msg.speech_final || msg.from_finalize) this.endUtterance();
      if (msg.from_finalize) this.resolveFlush();
    } else if (msg.type === 'UtteranceEnd') {
      this.endUtterance();
      this.handlers.onWordGap?.();
    } else if (msg.type === 'SpeechStarted') {
      this.handlers.onSpeechStarted?.();
    }
  }

  private resolveFlush(): void {
    const waiters = this.flushWaiters;
    this.flushWaiters = [];
    for (const resolve of waiters) resolve();
  }

  private endUtterance(): void {
    if (this.finals.length === 0) return;
    const text = this.finals.join(' ');
    this.finals = [];
    this.handlers.onUtteranceEnd?.(text);
  }

  private onClosed(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.endUtterance();
    this.resolveFlush();
    if (!this.closing) {
      logger.warn({ code, reason }, 'Deepgram stream closed unexpectedly');
      this.handlers.onError?.(
        new SpeechError(`Deepgram stream closed (${code}${reason ? `: ${reason}` : ''})`, true),
      );
    }
    if (this.info.meter && this.audioSeconds > 0) {
      recordSpeechUsage({
        task: 'stt',
        provider: 'deepgram',
        model: this.info.model,
        audioSeconds: Math.round(this.audioSeconds * 100) / 100,
        userId: this.info.ctx.userId,
        interviewId: this.info.ctx.interviewId,
      });
    }
    this.handlers.onClose?.();
  }
}

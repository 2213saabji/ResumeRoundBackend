import { createHash } from 'node:crypto';
import { createCache } from '../../common/cache.js';
import { logger } from '../../common/logger.js';
import type { ObjectStorage } from '../../common/storage/index.js';
import { bytesToPcm, concatPcm, pcmToBytes } from './audio.js';
import type { SynthesisOptions, TextToSpeech } from './types.js';

/**
 * Reuses audio for text spoken in many interviews (greeting, standard questions, closing), so it
 * is paid for once. Only requests with `cache: true` are cached. Hot phrases stay in memory;
 * everything cached is also kept in object storage, so it survives restarts and is shared by
 * every bot.
 */
export class CachedTts implements TextToSpeech {
  readonly provider: string;
  readonly voiceId: string;
  private readonly memory = createCache<Int16Array>({ max: 100, ttlMs: 24 * 60 * 60 * 1000 });

  constructor(
    private readonly inner: TextToSpeech,
    private readonly storage: ObjectStorage,
  ) {
    this.provider = inner.provider;
    this.voiceId = inner.voiceId;
  }

  async *stream(text: string, opts: SynthesisOptions): AsyncGenerator<Int16Array> {
    if (!opts.cache) {
      yield* this.inner.stream(text, opts);
      return;
    }

    const key = this.key(text);
    const hot = this.memory.get(key);
    if (hot) {
      yield hot;
      return;
    }

    const stored = await this.storage.get(key).catch(() => null);
    if (stored) {
      const pcm = bytesToPcm(stored);
      this.memory.set(key, pcm);
      yield pcm;
      return;
    }

    // Stream through to the listener while collecting; only complete audio is cached.
    const chunks: Int16Array[] = [];
    for await (const chunk of this.inner.stream(text, opts)) {
      chunks.push(chunk);
      yield chunk;
    }
    const pcm = concatPcm(chunks);
    if (pcm.length === 0) return;
    this.memory.set(key, pcm);
    this.storage
      .put(key, pcmToBytes(pcm), 'application/octet-stream')
      .catch((err: unknown) => logger.warn({ err }, 'failed to store cached TTS audio'));
  }

  /** Changes with the voice and its settings, so switching voice never replays old audio. */
  private key(text: string): string {
    const hash = createHash('sha256').update(`${this.voiceId}\n${text.trim()}`).digest('hex');
    return `tts-cache/${hash}.pcm`;
  }
}

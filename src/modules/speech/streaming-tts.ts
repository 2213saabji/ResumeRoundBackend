import { concatPcm } from './audio.js';
import type { SynthesisOptions, TextToSpeech } from './types.js';

/** Words ending in a full stop that do not end a sentence. Compared lower-case, without dots. */
const ABBREVIATIONS = new Set(['e.g', 'i.e', 'mr', 'mrs', 'ms', 'dr', 'prof', 'vs', 'approx']);
/** Longer runs without a full stop are split at a comma, so audio still starts early. */
const MAX_CHARS = 220;
const MIN_SOFT_SPLIT = 60;

function endsWithAbbreviation(sentence: string): boolean {
  const last = sentence.split(/\s+/).pop() ?? '';
  return ABBREVIATIONS.has(last.replace(/\.+$/, '').toLowerCase());
}

/**
 * Splits streamed LLM text into sentences that can be spoken one by one. A full stop only ends a
 * sentence once whitespace follows it, so "Node.js" and "3.5" are never split.
 */
export class SentenceChunker {
  private buf = '';

  push(delta: string): string[] {
    this.buf += delta;
    const out: string[] = [];
    for (let s = this.next(); s !== null; s = this.next()) out.push(s);
    return out;
  }

  /** The rest of the text, once the stream has ended. */
  flush(): string | null {
    const rest = this.buf.trim();
    this.buf = '';
    return rest || null;
  }

  private next(): string | null {
    const boundary = /([.!?]+["')\]]*)\s+|\n+/g;
    for (let m = boundary.exec(this.buf); m; m = boundary.exec(this.buf)) {
      const end = m.index + (m[1]?.length ?? 0);
      const sentence = this.buf.slice(0, end).trim();
      if (m[1]?.startsWith('.') && endsWithAbbreviation(sentence)) continue;
      this.buf = this.buf.slice(m.index + m[0].length);
      if (sentence) return sentence;
      return this.next();
    }
    if (this.buf.length > MAX_CHARS) {
      const head = this.buf.slice(0, MAX_CHARS);
      const cut = Math.max(head.lastIndexOf(', '), head.lastIndexOf('; '), head.lastIndexOf(': '));
      const at = cut >= MIN_SOFT_SPLIT ? cut + 1 : head.lastIndexOf(' ');
      if (at > 0) {
        const part = this.buf.slice(0, at).trim();
        this.buf = this.buf.slice(at).trimStart();
        return part;
      }
    }
    return null;
  }
}

/** Sentences from a stream of text deltas (e.g. a streaming LLM reply). */
export async function* chunkSentences(deltas: AsyncIterable<string>): AsyncGenerator<string> {
  const chunker = new SentenceChunker();
  for await (const delta of deltas) yield* chunker.push(delta);
  const rest = chunker.flush();
  if (rest) yield rest;
}

/**
 * Starts consuming `source` now and buffers what arrives, so a sentence can be synthesised
 * before it is played. Errors are raised to whoever iterates the result.
 */
function prefetch(source: AsyncIterable<Int16Array>): AsyncIterable<Int16Array> {
  const chunks: Int16Array[] = [];
  let done = false;
  let error: unknown;
  let wake: (() => void) | undefined;
  void (async () => {
    try {
      for await (const chunk of source) {
        chunks.push(chunk);
        wake?.();
      }
    } catch (err) {
      error = err;
    } finally {
      done = true;
      wake?.();
    }
  })();
  return {
    async *[Symbol.asyncIterator]() {
      for (let i = 0; ;) {
        if (i < chunks.length) {
          yield chunks[i++]!;
          continue;
        }
        if (error !== undefined) throw error;
        if (done) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = undefined;
      }
    },
  };
}

export interface SpokenChunk {
  /** The sentence this audio belongs to (for captions). */
  text: string;
  /** 16 kHz mono PCM, to play in order. */
  pcm: Int16Array;
  /** First chunk of its sentence. */
  first: boolean;
}

/**
 * Speaks sentences in order as a stream of audio chunks. Each sentence's audio is played as it
 * arrives, and while sentence N plays, sentence N+1 is already being synthesised, so the
 * interviewer speaks without gaps after the first sentence.
 */
export async function* speakSentences(
  tts: TextToSpeech,
  sentences: AsyncIterable<string> | Iterable<string>,
  opts: SynthesisOptions,
): AsyncGenerator<SpokenChunk> {
  const source =
    Symbol.asyncIterator in sentences
      ? sentences[Symbol.asyncIterator]()
      : sentences[Symbol.iterator]();
  const start = async () => {
    const next = await source.next();
    return next.done ? null : { text: next.value, audio: prefetch(tts.stream(next.value, opts)) };
  };

  let current = await start();
  while (current) {
    const upcoming = start();
    upcoming.catch(() => {}); // raised when awaited below; avoids an unhandled rejection
    let first = true;
    for await (const pcm of current.audio) {
      yield { text: current.text, pcm, first };
      first = false;
    }
    current = await upcoming;
  }
}

/** All of `text` as one buffer (for cached phrases, scripts and tests). */
export async function synthesizeAll(
  tts: TextToSpeech,
  text: string,
  opts: SynthesisOptions,
): Promise<Int16Array> {
  const chunks: Int16Array[] = [];
  for await (const chunk of tts.stream(text, opts)) chunks.push(chunk);
  return concatPcm(chunks);
}

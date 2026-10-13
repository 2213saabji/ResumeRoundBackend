import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalStorage } from '../../src/common/storage/local-storage.js';
import { encodeWav } from '../../src/modules/speech/audio.js';
import {
  DeepgramStt,
  type SttSocket,
  type DeepgramOptions,
} from '../../src/modules/speech/providers/deepgram.js';
import { DeepgramTts, auraTier } from '../../src/modules/speech/providers/deepgram-tts.js';
import { GoogleTts, voiceTier } from '../../src/modules/speech/providers/google-tts.js';
import { MockTts } from '../../src/modules/speech/providers/mock.js';
import { speakSentences, synthesizeAll } from '../../src/modules/speech/streaming-tts.js';
import { CachedTts } from '../../src/modules/speech/tts-cache.js';
import {
  SpeechError,
  type SttHandlers,
  type TextToSpeech,
} from '../../src/modules/speech/types.js';

class FakeSocket implements SttSocket {
  readyState = 0;
  sent: (string | Uint8Array)[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  send(data: string | Uint8Array): void {
    this.sent.push(data);
    // Deepgram answers CloseStream by closing the socket.
    if (typeof data === 'string' && data.includes('CloseStream')) {
      setTimeout(() => this.close(1000, ''), 0);
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }

  emit(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }

  jsonSent(): string[] {
    return this.sent.filter((d): d is string => typeof d === 'string');
  }
}

const results = (transcript: string, flags: Record<string, boolean> = {}) => ({
  type: 'Results',
  channel: { alternatives: [{ transcript }] },
  ...flags,
});

async function openDeepgram(handlers: SttHandlers = {}, keyterms?: string[]) {
  let socket!: FakeSocket;
  const opts: DeepgramOptions = {
    apiKey: 'dg-key',
    model: 'nova-3',
    language: 'en-IN',
    endpointingMs: 500,
    utteranceEndMs: 1000,
    meter: false,
    createSocket: (url, protocols) => {
      socket = new FakeSocket(url, protocols);
      queueMicrotask(() => {
        socket.readyState = 1;
        socket.onopen?.();
      });
      return socket;
    },
  };
  const stream = await new DeepgramStt(opts).openStream({ keyterms, ctx: {} }, handlers);
  return { stream, socket };
}

describe('DeepgramStt', () => {
  it('connects with the token subprotocol and the stream settings', async () => {
    const { stream, socket } = await openDeepgram({}, ['Kafka', ' Kafka ', 'PostgreSQL', '']);
    expect(socket.protocols).toEqual(['token', 'dg-key']);
    const url = new URL(socket.url);
    expect(url.host).toBe('api.deepgram.com');
    expect(url.searchParams.get('model')).toBe('nova-3');
    expect(url.searchParams.get('language')).toBe('en-IN');
    expect(url.searchParams.get('encoding')).toBe('linear16');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('utterance_end_ms')).toBe('1000');
    expect(url.searchParams.getAll('keyterm')).toEqual(['Kafka', 'PostgreSQL']);
    await stream.close();
  });

  it('reports partials, finals and the joined utterance once', async () => {
    const events: string[] = [];
    const { stream, socket } = await openDeepgram({
      onPartial: (t) => events.push(`partial:${t}`),
      onFinal: (t) => events.push(`final:${t}`),
      onUtteranceEnd: (t) => events.push(`utterance:${t}`),
      onSpeechStarted: () => events.push('started'),
      onWordGap: () => events.push('gap'),
    });
    socket.emit({ type: 'SpeechStarted' });
    socket.emit(results('we used', { is_final: false }));
    socket.emit(results('We used Kafka', { is_final: true }));
    socket.emit(results('for the queue.', { is_final: true, speech_final: true }));
    socket.emit({ type: 'UtteranceEnd' }); // nothing new since speech_final: no repeat, but a gap
    socket.emit(results('', { is_final: true, speech_final: true }));
    expect(events).toEqual([
      'started',
      'partial:we used',
      'final:We used Kafka',
      'final:for the queue.',
      'utterance:We used Kafka for the queue.',
      'gap',
    ]);
    await stream.close();
  });

  it('streams audio as bytes and counts the seconds sent', async () => {
    const { stream, socket } = await openDeepgram();
    stream.write(new Int16Array(16_000));
    stream.write(new Int16Array(8_000));
    expect(stream.audioSeconds).toBeCloseTo(1.5, 5);
    const audio = socket.sent.filter((d) => typeof d !== 'string');
    expect(audio.map((d) => d.byteLength)).toEqual([32_000, 16_000]);
    stream.finalize();
    expect(socket.jsonSent()).toContain(JSON.stringify({ type: 'Finalize' }));
    await stream.close();
  });

  it('resolves a flush as soon as Deepgram returns the flushed result', async () => {
    const finals: string[] = [];
    const { stream, socket } = await openDeepgram({ onFinal: (t) => finals.push(t) });
    const started = Date.now();
    const flushed = stream.finalize();
    socket.emit(results('the last words', { is_final: true, from_finalize: true }));
    await flushed;
    expect(Date.now() - started).toBeLessThan(200);
    expect(finals).toEqual(['the last words']);
    await stream.close();
  });

  it('closes gracefully and flushes an unfinished utterance', async () => {
    const onUtteranceEnd = vi.fn();
    const onClose = vi.fn();
    const onError = vi.fn();
    const { stream, socket } = await openDeepgram({ onUtteranceEnd, onClose, onError });
    socket.emit(results('half a sentence', { is_final: true }));
    await stream.close();
    expect(socket.jsonSent()).toContain(JSON.stringify({ type: 'CloseStream' }));
    expect(onUtteranceEnd).toHaveBeenCalledWith('half a sentence');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    stream.write(new Int16Array(320)); // ignored after close
    expect(stream.audioSeconds).toBe(0);
  });

  it('reports an unexpected close as a retryable error', async () => {
    const onError = vi.fn();
    const { socket } = await openDeepgram({ onError });
    socket.close(1011, 'NET-0001');
    const err = onError.mock.calls[0]?.[0] as SpeechError;
    expect(err).toBeInstanceOf(SpeechError);
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('NET-0001');
  });

  it('rejects when the connection fails', async () => {
    const stt = new DeepgramStt({
      apiKey: 'bad',
      model: 'nova-3',
      language: 'en',
      endpointingMs: 500,
      utteranceEndMs: 1000,
      createSocket: (url, protocols) => {
        const s = new FakeSocket(url, protocols);
        queueMicrotask(() => s.onerror?.());
        return s;
      },
    });
    await expect(stt.openStream({ ctx: {} }, {})).rejects.toThrow('DEEPGRAM_API_KEY');
  });
});

const speak = (tts: TextToSpeech, text: string, cache = false) =>
  synthesizeAll(tts, text, { ctx: {}, cache });

describe('DeepgramTts', () => {
  afterEach(() => vi.unstubAllGlobals());

  const tts = () => new DeepgramTts({ apiKey: 'dg-key', voice: 'aura-2-thalia-en', meter: false });

  it('requests raw 16 kHz PCM with the token header', async () => {
    const raw = Buffer.alloc(32_000); // 1 s of 16 kHz PCM
    const fetchMock = vi.fn(async () => new Response(raw, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    expect((await speak(tts(), ' Shall we begin? ')).length).toBe(16_000);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/speak');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'aura-2-thalia-en',
      encoding: 'linear16',
      sample_rate: '16000',
      container: 'none',
    });
    expect((init.headers as Record<string, string>).authorization).toBe('Token dg-key');
    expect(JSON.parse(init.body as string)).toEqual({ text: 'Shall we begin?' });
  });

  it('yields audio as it arrives, keeping samples whole across chunks', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3])); // 1.5 samples
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(body, { status: 200 })),
    );
    const chunks: number[][] = [];
    for await (const chunk of tts().stream('Hi.', { ctx: {} })) chunks.push(Array.from(chunk));
    expect(chunks).toEqual([[0x0201], [0x0403, 0x0605]]);
  });

  it('fails fast on a bad key', async () => {
    const fetchMock = vi.fn(async () => new Response('INVALID_AUTH', { status: 401 }));
    vi.stubGlobal('fetch', fetchMock);
    const err = await speak(tts(), 'Hi.').catch((e: unknown) => e);
    expect((err as SpeechError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('maps voices to pricing tiers', () => {
    expect(auraTier('aura-2-thalia-en')).toBe('aura-2');
    expect(auraTier('aura-asteria-en')).toBe('aura');
  });
});

describe('GoogleTts', () => {
  afterEach(() => vi.unstubAllGlobals());

  const tts = () =>
    new GoogleTts({
      apiKey: 'g-key',
      voice: 'en-IN-Chirp3-HD-Kore',
      speakingRate: 1,
      meter: false,
    });

  function stubFetch(...responses: Response[]) {
    const fetchMock = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('requests 16 kHz LINEAR16 and resamples whatever comes back', async () => {
    const wav24k = encodeWav(new Int16Array(24_000), 24_000); // 1 s at 24 kHz
    const fetchMock = stubFetch(
      Response.json({ audioContent: wav24k.toString('base64') }, { status: 200 }),
    );
    expect((await speak(tts(), '  Hello there.  ')).length).toBe(16_000);

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://texttospeech.googleapis.com/v1/text:synthesize');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('g-key');
    expect(JSON.parse(init.body as string)).toEqual({
      input: { text: 'Hello there.' },
      voice: { languageCode: 'en-IN', name: 'en-IN-Chirp3-HD-Kore' },
      audioConfig: { audioEncoding: 'LINEAR16', sampleRateHertz: 16_000 },
    });
  });

  it('does not call the API for empty text', async () => {
    const fetchMock = stubFetch();
    expect((await speak(tts(), '   ')).length).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast on a bad request', async () => {
    const fetchMock = stubFetch(new Response('voice not found', { status: 400 }));
    const err = await speak(tts(), 'Hi.').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpeechError);
    expect((err as SpeechError).retryable).toBe(false);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('retries a server error once', async () => {
    const fetchMock = stubFetch(
      new Response('busy', { status: 503 }),
      new Response('busy', { status: 503 }),
    );
    const err = await speak(tts(), 'Hi.').catch((e: unknown) => e);
    expect((err as SpeechError).retryable).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps voices to pricing tiers', () => {
    expect(voiceTier('en-IN-Chirp3-HD-Kore')).toBe('chirp3-hd');
    expect(voiceTier('en-IN-Neural2-A')).toBe('neural2');
    expect(voiceTier('en-US-Wavenet-D')).toBe('wavenet');
  });
});

/** Records when each sentence starts and finishes synthesising. */
class CountingTts implements TextToSpeech {
  readonly provider = 'counting';
  calls: string[] = [];
  events: string[] = [];
  constructor(readonly voiceId = 'voice-a') {}
  async *stream(text: string): AsyncGenerator<Int16Array> {
    this.calls.push(text);
    this.events.push(`start:${text}`);
    await new Promise((r) => setTimeout(r, 5));
    yield new Int16Array([1, 2]);
    yield new Int16Array([3]);
    this.events.push(`end:${text}`);
  }
}

describe('CachedTts', () => {
  const storage = async () =>
    new LocalStorage(await mkdtemp(path.join(os.tmpdir(), 'tts-cache-test-')));

  it('only caches when asked to', async () => {
    const inner = new CountingTts();
    const tts = new CachedTts(inner, await storage());
    await speak(tts, 'Tell me about yourself.');
    await speak(tts, 'Tell me about yourself.');
    expect(inner.calls).toHaveLength(2);
  });

  it('serves cached phrases from memory, then from storage after a restart', async () => {
    const store = await storage();
    const inner = new CountingTts();
    const tts = new CachedTts(inner, store);
    expect(Array.from(await speak(tts, 'Welcome!', true))).toEqual([1, 2, 3]);
    expect(Array.from(await speak(tts, 'Welcome!', true))).toEqual([1, 2, 3]);
    await new Promise((r) => setTimeout(r, 50)); // storage write is fire-and-forget

    const restarted = new CachedTts(inner, store);
    expect(Array.from(await speak(restarted, 'Welcome!', true))).toEqual([1, 2, 3]);
    expect(inner.calls).toEqual(['Welcome!']);
  });

  it('keeps voices apart', async () => {
    const store = await storage();
    await speak(new CachedTts(new CountingTts('voice-a'), store), 'Hi.', true);
    await new Promise((r) => setTimeout(r, 50));
    const other = new CountingTts('voice-b');
    await speak(new CachedTts(other, store), 'Hi.', true);
    expect(other.calls).toEqual(['Hi.']);
  });
});

describe('speakSentences', () => {
  it('keeps order and synthesises the next sentence while the current one plays', async () => {
    const inner = new CountingTts();
    const played: string[] = [];
    for await (const c of speakSentences(inner, ['One.', 'Two.', 'Three.'], { ctx: {} })) {
      played.push(`${c.first ? '*' : ''}${c.text}:${Array.from(c.pcm).join(',')}`);
    }
    expect(played).toEqual([
      '*One.:1,2',
      'One.:3',
      '*Two.:1,2',
      'Two.:3',
      '*Three.:1,2',
      'Three.:3',
    ]);
    expect(inner.events.indexOf('start:Two.')).toBeLessThan(inner.events.indexOf('end:One.'));
  });

  it('pulls sentences from an async stream', async () => {
    async function* sentences() {
      yield 'Hello.';
      yield 'Bye.';
    }
    const texts = new Set<string>();
    for await (const c of speakSentences(new MockTts(), sentences(), { ctx: {} })) {
      expect(c.pcm.length).toBeGreaterThan(0);
      texts.add(c.text);
    }
    expect([...texts]).toEqual(['Hello.', 'Bye.']);
  });

  it('raises a synthesis error to the listener', async () => {
    const failing: TextToSpeech = {
      provider: 'failing',
      voiceId: 'x',
      // eslint-disable-next-line require-yield
      async *stream() {
        throw new SpeechError('boom', false);
      },
    };
    const run = async () => {
      for await (const _chunk of speakSentences(failing, ['One.'], { ctx: {} })) {
        // nothing is yielded
      }
    };
    await expect(run()).rejects.toThrow('boom');
  });
});

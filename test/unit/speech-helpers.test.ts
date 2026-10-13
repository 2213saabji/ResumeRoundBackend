import { describe, expect, it } from 'vitest';
import { computeSpeechCostUsd } from '../../src/modules/ai/cost-meter.js';
import {
  FRAME_SAMPLES,
  SPEECH_SAMPLE_RATE,
  encodeWav,
  readWav,
  resample,
  rmsDbfs,
} from '../../src/modules/speech/audio.js';
import { MockStt } from '../../src/modules/speech/providers/mock.js';
import { GatedSttStream, SpeechGate } from '../../src/modules/speech/speech-gate.js';
import { SentenceChunker, chunkSentences } from '../../src/modules/speech/streaming-tts.js';

/** One 20 ms frame of a 220 Hz tone (amplitude 0 = silence). */
function frame(amplitude: number): Int16Array {
  const f = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < f.length; i++) {
    f[i] = Math.round(amplitude * Math.sin((2 * Math.PI * 220 * i) / SPEECH_SAMPLE_RATE));
  }
  return f;
}
const LOUD = 8_000;

describe('speech audio helpers', () => {
  it('round-trips PCM through WAV', () => {
    const pcm = frame(LOUD);
    const wav = readWav(encodeWav(pcm, 24_000));
    expect(wav.sampleRate).toBe(24_000);
    expect(Array.from(wav.pcm)).toEqual(Array.from(pcm));
  });

  it('averages stereo WAV to mono', () => {
    const wav = encodeWav(new Int16Array([100, 300, -200, 0]));
    wav.writeUInt16LE(2, 22); // declare 2 channels: frames (100, 300) and (-200, 0)
    expect(Array.from(readWav(wav).pcm)).toEqual([200, -100]);
  });

  it('rejects files that are not WAV', () => {
    expect(() => readWav(Buffer.from('not audio at all, really'))).toThrow('Not a WAV file');
  });

  it('resamples to the target rate', () => {
    expect(resample(new Int16Array(24_000), 24_000, 16_000).length).toBe(16_000);
    const same = new Int16Array(10);
    expect(resample(same, 16_000, 16_000)).toBe(same);
  });

  it('measures loudness', () => {
    expect(rmsDbfs(frame(0))).toBeLessThan(-100);
    expect(rmsDbfs(frame(32_767))).toBeCloseTo(-3, 0);
  });
});

describe('SpeechGate', () => {
  it('sends nothing for silence', () => {
    const gate = new SpeechGate();
    for (let i = 0; i < 100; i++) expect(gate.push(frame(0)).send).toHaveLength(0);
    expect(gate.savedSeconds).toBeCloseTo(2, 5);
  });

  it('ignores blips shorter than the minimum speech length', () => {
    const gate = new SpeechGate();
    gate.push(frame(LOUD));
    gate.push(frame(LOUD));
    for (let i = 0; i < 10; i++) gate.push(frame(0));
    expect(gate.isOpen).toBe(false);
  });

  it('opens with the pre-roll and closes after the hangover', () => {
    const gate = new SpeechGate({ preRollMs: 300, minSpeechMs: 60, hangoverMs: 1_500 });
    for (let i = 0; i < 30; i++) gate.push(frame(0));
    gate.push(frame(LOUD));
    gate.push(frame(LOUD));
    const opened = gate.push(frame(LOUD));
    expect(gate.isOpen).toBe(true);
    expect(opened.send).toHaveLength(15); // 300 ms of pre-roll, ending with the voiced frames
    expect(opened.send.at(-1)).toEqual(frame(LOUD));

    let endedAt = -1;
    for (let i = 0; i < 100 && endedAt < 0; i++) {
      const r = gate.push(frame(0));
      expect(r.send).toHaveLength(1);
      if (r.ended) endedAt = i;
    }
    expect(endedAt).toBe(74); // 1,500 ms of silence = 75 frames
    expect(gate.isOpen).toBe(false);
  });

  it('ends a mock utterance when the gate closes', async () => {
    const utterances: string[] = [];
    const inner = await new MockStt().openStream(
      { ctx: {} },
      { onUtteranceEnd: (t) => utterances.push(t) },
    );
    const stream = new GatedSttStream(inner);
    for (let i = 0; i < 50; i++) stream.write(frame(0));
    for (let i = 0; i < 50; i++) stream.write(frame(LOUD));
    for (let i = 0; i < 80; i++) stream.write(frame(0));
    expect(utterances).toHaveLength(1);
    // 15 pre-roll frames + 47 more voiced + 75 silent; the rest of the silence was not sent.
    expect(stream.audioSeconds).toBeCloseTo((15 + 47 + 75) * 0.02, 5);
  });
});

describe('SentenceChunker', () => {
  it('emits complete sentences and keeps the rest', () => {
    const c = new SentenceChunker();
    expect(c.push('Hello there. How are you? I')).toEqual(['Hello there.', 'How are you?']);
    expect(c.flush()).toBe('I');
    expect(c.flush()).toBeNull();
  });

  it('gives the same result when text arrives character by character', () => {
    const text = 'Got it. Tell me about the queue! Why Kafka?';
    const c = new SentenceChunker();
    const got = [...text].flatMap((ch) => c.push(ch));
    expect([...got, c.flush()]).toEqual(['Got it.', 'Tell me about the queue!', 'Why Kafka?']);
  });

  it('does not split inside names, numbers or abbreviations', () => {
    const c = new SentenceChunker();
    expect(c.push('We moved to Node.js and v3.5 in prod. Use e.g. Redis there. Next')).toEqual([
      'We moved to Node.js and v3.5 in prod.',
      'Use e.g. Redis there.',
    ]);
  });

  it('splits on new lines', () => {
    expect(new SentenceChunker().push('First line\n\nSecond line\n')).toEqual([
      'First line',
      'Second line',
    ]);
  });

  it('splits long runs at a comma', () => {
    const long = `${'word '.repeat(20)}and then, ${'more '.repeat(40)}`;
    const [first] = new SentenceChunker().push(long);
    expect(first?.endsWith('and then,')).toBe(true);
  });

  it('chunks an async stream of deltas', async () => {
    async function* deltas() {
      yield 'Okay. Let';
      yield "'s talk about caching";
    }
    const out: string[] = [];
    for await (const s of chunkSentences(deltas())) out.push(s);
    expect(out).toEqual(['Okay.', "Let's talk about caching"]);
  });
});

describe('computeSpeechCostUsd', () => {
  it('prices STT per minute and TTS per million characters', () => {
    expect(computeSpeechCostUsd('deepgram:nova-3', { audioSeconds: 60 })).toBe(0.0077);
    expect(computeSpeechCostUsd('google:chirp3-hd', { characters: 10_000 })).toBe(0.3);
    expect(computeSpeechCostUsd('unknown:model', { characters: 10 })).toBe(0);
  });
});

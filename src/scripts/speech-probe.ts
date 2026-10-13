/**
 * Tries the real speech providers from a laptop, without the bot or a database. Reads the keys
 * from .env (DEEPGRAM_API_KEY, GOOGLE_TTS_API_KEY) whatever STT_PROVIDER / TTS_PROVIDER say.
 * Nothing is written to ai_usage; costs are printed instead.
 *
 *   npx tsx src/scripts/speech-probe.ts voices
 *   npx tsx src/scripts/speech-probe.ts samples [voice ...]
 *   npx tsx src/scripts/speech-probe.ts tts "Hi, I'm your interviewer today. Shall we begin?"
 *   npx tsx src/scripts/speech-probe.ts stt answer.wav [--keyterms=Kubernetes,PostgreSQL]
 *   npx tsx src/scripts/speech-probe.ts roundtrip "We sharded PostgreSQL by tenant ID."
 *
 * Options: --tts=deepgram|google (default: TTS_PROVIDER, else deepgram), --voice=<name>,
 * --lang=<code> (Google voices only, default en-IN).
 *
 * Audio files go to .storage/speech-probe/. `samples` says the same interviewer lines in several
 * voices to compare. `stt` streams the WAV in real time, like a live call, and reports how long
 * after the end of speech each utterance arrived.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DEFAULT_TTS_VOICE, config } from '../common/config.js';
import { computeSpeechCostUsd } from '../modules/ai/cost-meter.js';
import {
  FRAME_SAMPLES,
  SPEECH_SAMPLE_RATE,
  concatPcm,
  durationMs,
  encodeWav,
  readWav,
  resample,
  rmsDbfs,
} from '../modules/speech/audio.js';
import { DeepgramTts, auraTier } from '../modules/speech/providers/deepgram-tts.js';
import { DeepgramStt } from '../modules/speech/providers/deepgram.js';
import { GoogleTts, voiceTier } from '../modules/speech/providers/google-tts.js';
import { DEFAULT_GATE, GatedSttStream } from '../modules/speech/speech-gate.js';
import { SentenceChunker, speakSentences } from '../modules/speech/streaming-tts.js';

const OUT_DIR = path.resolve(config.LOCAL_STORAGE_DIR, 'speech-probe');
const SAMPLE_TEXT =
  "Hi, thanks for joining today. I'll be your interviewer. Let's start with your most recent " +
  'project. What problem were you solving, and what was your role in it?';
const out = (line: string) =>
  process.stdout.write(`${line}
`);
const usd = (n: number) => `$${n.toFixed(4)}`;

const args = process.argv.slice(2);
const flag = (name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;
const [command, ...positional] = args.filter((a) => !a.startsWith('--'));

type TtsProvider = 'deepgram' | 'google';
const ttsProvider: TtsProvider =
  (flag('tts') as TtsProvider | undefined) ??
  (config.TTS_PROVIDER === 'mock' ? 'deepgram' : config.TTS_PROVIDER);
const defaultVoice = flag('voice') ?? config.TTS_VOICE ?? DEFAULT_TTS_VOICE[ttsProvider];

function need(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

function makeTts(voice = defaultVoice) {
  if (ttsProvider === 'google') {
    return {
      engine: new GoogleTts({
        apiKey: need(config.GOOGLE_TTS_API_KEY, 'GOOGLE_TTS_API_KEY'),
        voice,
        speakingRate: config.TTS_SPEAKING_RATE,
        meter: false,
      }),
      costKey: `google:${voiceTier(voice)}`,
    };
  }
  return {
    engine: new DeepgramTts({
      apiKey: need(config.DEEPGRAM_API_KEY, 'DEEPGRAM_API_KEY'),
      voice,
      meter: false,
    }),
    costKey: `deepgram:${auraTier(voice)}`,
  };
}

function makeStt() {
  return new DeepgramStt({
    apiKey: need(config.DEEPGRAM_API_KEY, 'DEEPGRAM_API_KEY'),
    model: config.STT_MODEL,
    language: config.STT_LANGUAGE,
    endpointingMs: config.STT_ENDPOINTING_MS,
    utteranceEndMs: config.STT_UTTERANCE_END_MS,
    meter: false,
  });
}

async function listVoices(): Promise<{ name: string; note: string }[]> {
  const { engine } = makeTts();
  if (engine instanceof GoogleTts) {
    const list = await engine.listVoices(flag('lang') ?? 'en-IN');
    return list.map((v) => ({ name: v.name, note: v.ssmlGender }));
  }
  const list = await engine.listVoices();
  return list
    .filter((v) => v.name.startsWith('aura-2-') && v.name.endsWith('-en'))
    .map((v) => ({ name: v.name, note: [v.accent, ...(v.tags ?? [])].filter(Boolean).join(', ') }));
}

async function voices() {
  const list = (await listVoices()).sort((a, b) => a.name.localeCompare(b.name));
  out(`${list.length} ${ttsProvider} voices:`);
  for (const v of list) out(`  ${v.name.padEnd(36)} ${v.note}`);
}

async function tts(text: string, voice = defaultVoice, file = 'tts.wav'): Promise<Int16Array> {
  const { engine, costKey } = makeTts(voice);
  const chunker = new SentenceChunker();
  const sentences = [...chunker.push(text), chunker.flush()].filter((s): s is string => !!s);

  const started = performance.now();
  const parts: Int16Array[] = [];
  for await (const chunk of speakSentences(engine, sentences, { ctx: {} })) {
    if (chunk.first) {
      const at = performance.now() - started;
      if (parts.length === 0)
        out(`first audio after ${at.toFixed(0)} ms (what the candidate waits)`);
      out(`  "${chunk.text}"`);
    }
    parts.push(chunk.pcm);
  }
  const characters = sentences.reduce((n, s) => n + s.length, 0);
  const pcm = concatPcm(parts);
  await mkdir(OUT_DIR, { recursive: true });
  const target = path.join(OUT_DIR, file);
  await writeFile(target, encodeWav(pcm));
  const cost = computeSpeechCostUsd(costKey, { characters });
  out(
    `voice ${voice}: ${(durationMs(pcm) / 1000).toFixed(1)} s of audio, ${characters} chars, ` +
      `${usd(cost)}; saved ${target}`,
  );
  return pcm;
}

/** The same interviewer lines in several voices; Indian-English voices first when offered. */
async function samples(names: string[]) {
  let chosen = names;
  if (chosen.length === 0) {
    const list = await listVoices();
    const indian = list.filter((v) => /indian|en-in/i.test(`${v.name} ${v.note}`));
    chosen = [...indian, ...list.filter((v) => !indian.includes(v))].slice(0, 6).map((v) => v.name);
  }
  for (const voice of chosen) {
    out(`--- ${voice} ---`);
    await tts(SAMPLE_TEXT, voice, `sample-${voice}.wav`);
  }
}

/** Streams PCM in real time (20 ms frames) through the speech gate into Deepgram. */
async function stt(pcm: Int16Array, keyterms: string[]): Promise<string> {
  const engine = makeStt();
  const started = performance.now();
  const t = () => `${((performance.now() - started) / 1000).toFixed(2)}s`;
  let lastVoicedAt = 0;
  const utterances: string[] = [];

  const inner = await engine.openStream(
    { keyterms, ctx: {} },
    {
      onPartial: (text) => out(`[${t()}] partial  ${text}`),
      onFinal: (text) => out(`[${t()}] final    ${text}`),
      onUtteranceEnd: (text) => {
        const lag = lastVoicedAt ? (performance.now() - lastVoicedAt).toFixed(0) : '?';
        out(`[${t()}] UTTERANCE (${lag} ms after speech ended)  ${text}`);
        utterances.push(text);
      },
      onError: (err) => out(`[${t()}] ERROR ${err.message}`),
    },
  );
  const stream = new GatedSttStream(inner);

  // Two seconds of trailing silence lets the end of the last utterance be detected.
  const padded = concatPcm([pcm, new Int16Array(SPEECH_SAMPLE_RATE * 2)]);
  const frames = Math.ceil(padded.length / FRAME_SAMPLES);
  const t0 = performance.now();
  for (let i = 0; i < frames; i++) {
    const frame = padded.slice(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES);
    if (rmsDbfs(frame) > DEFAULT_GATE.thresholdDb) lastVoicedAt = performance.now();
    stream.write(frame);
    const wait = t0 + (i + 1) * 20 - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  await stream.close();

  const total = durationMs(padded) / 1000;
  const cost = computeSpeechCostUsd(`deepgram:${config.STT_MODEL}`, {
    audioSeconds: stream.audioSeconds,
  });
  out(
    `audio ${total.toFixed(1)} s, sent ${stream.audioSeconds.toFixed(1)} s ` +
      `(gate saved ${stream.gate.savedSeconds.toFixed(1)} s), ${usd(cost)}`,
  );
  return utterances.join(' ');
}

async function sttFile(file: string, keyterms: string[]) {
  const wav = readWav(await readFile(file));
  await stt(resample(wav.pcm, wav.sampleRate, SPEECH_SAMPLE_RATE), keyterms);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

async function roundtrip(text: string, keyterms: string[]) {
  out('--- TTS ---');
  const pcm = await tts(text);
  out('--- STT ---');
  const heard = await stt(pcm, keyterms);
  const expected = words(text);
  const got = new Set(words(heard));
  const missed = expected.filter((w) => !got.has(w));
  out('--- Result ---');
  out(`said:  ${text}`);
  out(`heard: ${heard}`);
  out(`words recognised: ${expected.length - missed.length}/${expected.length}`);
  if (missed.length) out(`missed: ${missed.join(', ')}`);
}

const keyterms = flag('keyterms')?.split(',') ?? [];
const [arg] = positional;

try {
  if (command === 'voices') await voices();
  else if (command === 'samples') await samples(positional);
  else if (command === 'tts' && arg) await tts(arg);
  else if (command === 'stt' && arg) await sttFile(arg, keyterms);
  else if (command === 'roundtrip' && arg) await roundtrip(arg, keyterms);
  else {
    out(
      'usage: speech-probe voices | samples [voice ...] | tts "<text>" | stt <file.wav> | ' +
        'roundtrip "<text>"  [--tts=deepgram|google] [--voice=<name>] [--keyterms=a,b]',
    );
    process.exitCode = 1;
  }
} catch (err) {
  out(`failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

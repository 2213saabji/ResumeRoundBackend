/**
 * End-to-end voice interview against the real dev media server, with a simulated candidate.
 * Not part of `npm test` (it needs Janus, Deepgram and network access). Run it manually:
 *
 *   STT_PROVIDER=deepgram TTS_PROVIDER=deepgram npx tsx test/e2e/voice-call.ts
 *
 * Uses AI_PROVIDER from .env unless overridden (mock = instant questions, for checking the
 * call itself). The database is a throwaway in-memory replica set; nothing touches Atlas.
 *
 * What happens: a candidate with a profile starts a voice interview and calls `join` (rooms,
 * PIN, token, as the browser would). The interviewer bot (InterviewCall) and a simulated
 * candidate both join the room over WebRTC. The candidate waits for each question, speaks an
 * answer (Deepgram TTS in a different voice), and measures how long the interviewer takes to
 * reply. After two spoken answers it types one ("Type instead"), then presses End. The audio the candidate heard is saved
 * to .storage/voice-e2e/heard.wav.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { config } from '../../src/common/config.js';
import { connectDb, disconnectDb } from '../../src/common/db.js';
import { logger } from '../../src/common/logger.js';
import { InterviewModel, InterviewTurnModel } from '../../src/modules/interviews/model.js';
import { interviewsService } from '../../src/modules/interviews/service.js';
import { joinAudioRoom } from '../../src/modules/media/audio-link.js';
import { botRegistry } from '../../src/modules/media/bot-registry.js';
import { InterviewCall } from '../../src/modules/media/interview-call.js';
import { signJanusToken } from '../../src/modules/media/janus-auth.js';
import {
  AUDIOBRIDGE_PLUGIN,
  JanusClient,
  TEXTROOM_PLUGIN,
} from '../../src/modules/media/janus-client.js';
import { JanusWs } from '../../src/modules/media/janus-ws.js';
import { CandidateProfileModel } from '../../src/modules/profiles/model.js';
import { UserModel } from '../../src/modules/users/model.js';
import {
  SPEECH_SAMPLE_RATE,
  concatPcm,
  encodeWav,
  rmsDbfs,
} from '../../src/modules/speech/audio.js';
import { getSpeechToText, getTextToSpeech } from '../../src/modules/speech/gateway.js';
import { DeepgramTts } from '../../src/modules/speech/providers/deepgram-tts.js';
import { synthesizeAll } from '../../src/modules/speech/streaming-tts.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const at = () => `[${((performance.now() - t0) / 1000).toFixed(1)}s]`;

const ANSWERS = [
  'I built the payment gateway in Node.js. Every request carries an idempotency key that we ' +
    'store in Redis with the result, so a retried payment returns the stored result instead of ' +
    'charging the customer twice.',
  'We moved order events to Kafka and partitioned by merchant ID, so events for one merchant ' +
    'stay in order. Consumers commit offsets only after the database write succeeds.',
];

if (!config.JANUS_WS_URL || !config.JANUS_HTTP_URL || !config.JANUS_TOKEN_SECRET) {
  throw new Error('Set the JANUS_* values in .env');
}
if (config.STT_PROVIDER === 'mock' || config.TTS_PROVIDER === 'mock') {
  out(
    'note: STT_PROVIDER / TTS_PROVIDER are mock; run with STT_PROVIDER=deepgram TTS_PROVIDER=deepgram',
  );
}
const tokenSecret = config.JANUS_TOKEN_SECRET;
const janusToken = () =>
  signJanusToken({
    secret: tokenSecret,
    plugins: [AUDIOBRIDGE_PLUGIN, TEXTROOM_PLUGIN],
    ttlSeconds: 300,
  });

const replSet = await MongoMemoryReplSet.create({
  replSet: { count: 1, storageEngine: 'wiredTiger' },
});
await connectDb(replSet.getUri(), { dbName: 'voice_e2e' });
await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));

const botJanus = new JanusWs(config.JANUS_WS_URL, janusToken);
const candidateJanus = new JanusWs(config.JANUS_WS_URL, janusToken);
let exitCode = 0;

try {
  // --- A candidate with a profile starts a voice interview and joins, as the browser would ---
  const user = await UserModel.create({
    email: `voice-e2e-${Date.now()}@example.com`,
    name: 'Voice E2E',
    authProvider: 'password',
    passwordHash: 'x',
    targetRole: 'backend',
    level: 'sde2',
    companyType: 'product',
  });
  const userId = user._id.toString();
  await CandidateProfileModel.create({
    userId,
    seniority: 'sde2',
    experienceYears: 4,
    skills: {
      languages: ['TypeScript'],
      frameworks: ['Node.js'],
      databases: ['PostgreSQL', 'Redis'],
      cloud: ['AWS'],
      architecture: ['Kafka'],
    },
    projects: [
      {
        name: 'Payment Gateway',
        technologies: ['Node.js', 'Redis', 'Kafka'],
        description: 'Payments for a fintech startup',
        scaleSignals: ['2000 RPS'],
      },
    ],
  });
  const created = await interviewsService.create(userId, { durationMin: 15, mode: 'voice' });
  const id = created.id;
  out(`${at()} interview ${id} created (AI_PROVIDER=${config.AI_PROVIDER})`);
  await interviewsService.start(userId, id);
  const botId = 'bot-e2e';
  await botRegistry.heartbeat({ botId, host: 'e2e', capacity: 1, activeInterviews: 0 });
  const join = await interviewsService.join(userId, id);
  out(`${at()} join -> room ${join.room}, pin ${join.pin}, ${join.iceServers.length} ICE entries`);

  // --- The interviewer bot joins and runs the call ---
  await botJanus.connect();
  await candidateJanus.connect();
  const call = new InterviewCall(
    {
      janus: botJanus,
      rooms: new JanusClient(config.JANUS_HTTP_URL, { tokenSecret }),
      stt: getSpeechToText(),
      tts: getTextToSpeech(),
      log: logger.child({ e2e: 'bot' }),
      pollMs: 500,
      prebuffer: config.BOT_JANUS_PREBUFFER,
    },
    id,
  );
  const callDone = call.run();

  // --- The simulated candidate joins, listens, and answers ---
  const candidate = await joinAudioRoom(candidateJanus, {
    roomId: join.room,
    pin: join.pin,
    display: 'candidate',
  });
  out(`${at()} candidate connected`);
  const heard: Int16Array[] = [];
  let lastLoudAt = 0;
  let firstLoudAfter = 0;
  let waitingSince = 0;
  candidate.onAudio((pcm) => {
    heard.push(pcm);
    if (rmsDbfs(pcm) > -45) {
      lastLoudAt = performance.now();
      if (waitingSince && !firstLoudAfter) firstLoudAfter = lastLoudAt;
    }
  });

  const voice = new DeepgramTts({
    apiKey: config.DEEPGRAM_API_KEY!,
    voice: 'aura-2-apollo-en',
    meter: false,
  });
  const waitFor = async (what: string, ok: () => boolean, ms: number) => {
    const deadline = performance.now() + ms;
    while (!ok()) {
      if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await sleep(50);
    }
  };

  for (const [i, text] of ANSWERS.entries()) {
    await waitFor('the interviewer to finish speaking', () => call.state === 'listening', 180_000);
    const turn = await InterviewTurnModel.findOne({ interviewId: id }).sort({ seq: -1 }).lean();
    out(`${at()} interviewer asked (seq ${turn?.seq}): "${turn?.questionText}"`);
    await sleep(800);

    out(`${at()} candidate answers: "${text.slice(0, 70)}..."`);
    await candidate.play(await synthesizeAll(voice, text, { ctx: {} }));
    waitingSince = performance.now();
    firstLoudAfter = 0;
    await waitFor('the interviewer to start replying', () => firstLoudAfter > 0, 180_000);
    out(
      `${at()} interviewer started replying ${((firstLoudAfter - waitingSince) / 1000).toFixed(2)} s ` +
        `after the candidate stopped (answer ${i + 1})`,
    );
    waitingSince = 0;
  }

  // The candidate types the next answer instead of speaking ("Type instead" box).
  await waitFor('the interviewer to finish speaking', () => call.state === 'listening', 180_000);
  const before = await InterviewTurnModel.countDocuments({ interviewId: id });
  const current = await InterviewModel.findById(id).lean();
  out(`${at()} candidate types answer ${current?.state.questionsAsked} instead of speaking`);
  await interviewsService.submitAnswer(userId, id, {
    seq: current!.state.questionsAsked,
    answerText: 'We load-tested with k6 at twice the peak traffic and watched p99 latency.',
  });
  await waitFor(
    'the interviewer to notice the typed answer',
    () => call.state === 'speaking',
    30_000,
  );
  out(`${at()} interviewer noticed the typed answer and is speaking the next question`);
  await waitFor('the interviewer to finish speaking', () => call.state === 'listening', 180_000);
  const after = await InterviewTurnModel.countDocuments({ interviewId: id });
  out(`${at()} turns ${before} -> ${after}`);

  out(`${at()} candidate presses End`);
  await interviewsService.end(userId, id);
  await Promise.race([callDone, sleep(15_000)]);
  out(`${at()} bot call state: ${call.state}`);

  const turns = await InterviewTurnModel.find({ interviewId: id }).sort({ seq: 1 }).lean();
  out('\n--- Stored transcript ---');
  for (const t of turns) {
    out(`Q${t.seq}: ${t.questionText}`);
    out(`A${t.seq}: ${t.answerText ?? '(none)'}`);
  }
  const final = await InterviewModel.findById(id).lean();
  out(
    `\nstatus ${final?.status}, endReason ${final?.endReason}, reportStatus ${final?.reportStatus}`,
  );

  const dir = path.resolve(config.LOCAL_STORAGE_DIR, 'voice-e2e');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'heard.wav'), encodeWav(concatPcm(heard), SPEECH_SAMPLE_RATE));
  out(`saved what the candidate heard: ${path.join(dir, 'heard.wav')}`);
  await candidate.close();
} catch (err) {
  out(`\nFAILED ${at()}: ${err instanceof Error ? err.stack : String(err)}`);
  exitCode = 1;
} finally {
  await botJanus.close().catch(() => {});
  await candidateJanus.close().catch(() => {});
  await disconnectDb();
  await replSet.stop();
  process.exit(exitCode);
}

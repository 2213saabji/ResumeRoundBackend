import os from 'node:os';
import { config } from '../common/config.js';
import { connectDb, disconnectDb } from '../common/db.js';
import { logger } from '../common/logger.js';
import { onShutdown } from '../common/shutdown.js';
import { interviewsRepository } from '../modules/interviews/repository.js';
import { botRegistry } from '../modules/media/bot-registry.js';
import { InterviewCall } from '../modules/media/interview-call.js';
import { signJanusToken } from '../modules/media/janus-auth.js';
import { AUDIOBRIDGE_PLUGIN, JanusClient, TEXTROOM_PLUGIN } from '../modules/media/janus-client.js';
import { JanusWs } from '../modules/media/janus-ws.js';
import { getSpeechToText, getTextToSpeech } from '../modules/speech/gateway.js';

/**
 * Interview bot worker: heartbeats so the API can assign voice interviews to it, then runs a
 * live call (InterviewCall) for every in-progress voice interview assigned to it. If its
 * Janus connection drops it exits, and the process manager restarts it; candidates rejoin and
 * calls resume from the current question (all state is in the database).
 */
const log = logger.child({ app: 'bot' });
const botId = `bot-${config.WORKER_ID}`;

if (!config.JANUS_WS_URL || !config.JANUS_HTTP_URL || !config.JANUS_TOKEN_SECRET) {
  log.fatal('JANUS_WS_URL, JANUS_HTTP_URL and JANUS_TOKEN_SECRET are required to run the bot');
  process.exit(1);
}
const tokenSecret = config.JANUS_TOKEN_SECRET;

await connectDb(config.MONGODB_URI);

const janus = new JanusWs(config.JANUS_WS_URL, () =>
  signJanusToken({
    secret: tokenSecret,
    plugins: [AUDIOBRIDGE_PLUGIN, TEXTROOM_PLUGIN],
    ttlSeconds: 300,
  }),
);
await janus.connect();
janus.onClose = () => {
  log.fatal('Janus connection lost; exiting so the bot restarts');
  process.exit(1);
};

const rooms = new JanusClient(config.JANUS_HTTP_URL, { tokenSecret });
const calls = new Map<string, InterviewCall>();
/** Interviews whose call failed to start recently: wait before trying again. */
const retryAfter = new Map<string, number>();

function startCall(interviewId: string): void {
  const call = new InterviewCall(
    {
      janus,
      rooms,
      stt: getSpeechToText(),
      tts: getTextToSpeech(),
      log: log.child({ interviewId }),
      pollMs: config.BOT_POLL_MS,
      collector: {
        graceMs: config.BOT_TURN_END_MS,
        shortAnswerWaitMs: config.BOT_SHORT_ANSWER_WAIT_MS,
        minWords: config.BOT_MIN_ANSWER_WORDS,
      },
    },
    interviewId,
  );
  calls.set(interviewId, call);
  const startedAt = Date.now();
  call
    .run()
    .catch((err: unknown) => log.error({ err, interviewId }, 'interview call crashed'))
    .finally(() => {
      calls.delete(interviewId);
      // A call that ends within seconds failed to start: back off before the next attempt.
      if (Date.now() - startedAt < 10_000) retryAfter.set(interviewId, Date.now() + 5_000);
    });
}

async function tick(): Promise<void> {
  try {
    const live = await interviewsRepository.findLiveForBot(botId);
    const ids = live.map((i) => i._id.toString());
    for (const id of ids) {
      if (calls.has(id) || (retryAfter.get(id) ?? 0) > Date.now()) continue;
      if (calls.size >= config.BOT_CAPACITY) break;
      retryAfter.delete(id);
      startCall(id);
    }
    await interviewsRepository.touchBot(ids, botId);
    await botRegistry.heartbeat({
      botId,
      host: os.hostname(),
      capacity: config.BOT_CAPACITY,
      activeInterviews: calls.size,
    });
  } catch (err) {
    log.error({ err }, 'bot tick failed');
  }
}

await tick();
const timer = setInterval(() => void tick(), config.BOT_POLL_MS);
log.info(
  {
    botId,
    capacity: config.BOT_CAPACITY,
    stt: config.STT_PROVIDER,
    tts: config.TTS_PROVIDER,
    ai: config.AI_PROVIDER,
  },
  'interview bot started',
);

onShutdown(async () => {
  clearInterval(timer);
  await Promise.all([...calls.values()].map((c) => c.stop()));
  await janus.close();
  await botRegistry.remove(botId).catch(() => {});
  await disconnectDb();
});

import os from 'node:os';
import { config } from '../common/config.js';
import { connectDb, disconnectDb } from '../common/db.js';
import { logger } from '../common/logger.js';
import { onShutdown } from '../common/shutdown.js';
import { botRegistry } from '../modules/media/bot-registry.js';

/**
 * Interview bot worker. Today it only registers itself and heartbeats so the API can assign
 * interviews to it. MVP-4 adds: joining Janus rooms, Opus -> PCM -> streaming STT, the turn
 * loop (state machine + turn controller), streaming TTS back into the room, per-turn
 * checkpoints, and claiming interviews from bots whose heartbeat went stale.
 */
const log = logger.child({ app: 'bot' });
const botId = `bot-${config.WORKER_ID}`;
const activeInterviews = new Map<string, unknown>();

await connectDb(config.MONGODB_URI);

async function heartbeat() {
  try {
    await botRegistry.heartbeat({
      botId,
      host: os.hostname(),
      capacity: config.BOT_CAPACITY,
      activeInterviews: activeInterviews.size,
    });
  } catch (err) {
    log.error({ err }, 'bot heartbeat failed');
  }
}

await heartbeat();
const timer = setInterval(heartbeat, config.BOT_HEARTBEAT_MS);
log.info(
  { botId, capacity: config.BOT_CAPACITY },
  'interview bot started (Janus bridge not implemented yet)',
);

onShutdown(async () => {
  clearInterval(timer);
  await botRegistry.remove(botId).catch(() => {});
  await disconnectDb();
});

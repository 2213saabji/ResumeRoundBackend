/**
 * Scripted "candidates" for the load test: each joins its room as a plain-RTP participant,
 * speaks a clip, and measures the time from the end of its speech to the start of the bot's
 * reply as heard in the room mix. Runs in its own process so its CPU is not counted as the bot's.
 */
import { FRAME_SAMPLES, createOpus, rmsDbfs, synthesize, toInt16 } from './audio.js';
import { connectJanus } from './common.js';
import { joinPlainRtp } from './transport-a.js';
import { sleep } from './turn-bot.js';

const THRESHOLD_DB = Number(process.env.THRESHOLD_DB ?? -45);
const REPLY_TIMEOUT_MS = 10_000;

const clip = synthesize(
  'I would put the jobs on a queue, and retry the failures with exponential backoff.',
);
const encoder = createOpus();
const frames: { opus: Buffer; voiced: boolean }[] = [];
for (let i = 0; i * FRAME_SAMPLES < clip.length; i++) {
  const pcm = new Int16Array(FRAME_SAMPLES);
  pcm.set(clip.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES));
  frames.push({
    opus: Buffer.from(encoder.encode(Buffer.from(pcm.buffer), FRAME_SAMPLES)),
    voiced: rmsDbfs(pcm) > THRESHOLD_DB,
  });
}

async function runUser(room: number, turns: number) {
  const janus = await connectJanus();
  const link = await joinPlainRtp(janus, room, 'fake candidate');
  const decoder = createOpus();
  let loudSince = 0;
  let lastLoud = 0;
  link.onOpus((payload) => {
    let level: number;
    try {
      level = rmsDbfs(toInt16(decoder.decode(payload)));
    } catch {
      return;
    }
    const now = performance.now();
    if (level > THRESHOLD_DB) {
      if (now - lastLoud > 300) loudSince = now;
      lastLoud = now;
    }
  });
  // Open the media path, as the bot does.
  link.send(frames[0]!.opus, FRAME_SAMPLES, true);
  await sleep(1500);

  const delays: number[] = [];
  let misses = 0;
  for (let t = 0; t < turns; t++) {
    const start = performance.now();
    let lastVoicedSent = 0;
    for (let i = 0; i < frames.length; i++) {
      link.send(frames[i]!.opus, FRAME_SAMPLES, i === 0);
      if (frames[i]!.voiced) lastVoicedSent = performance.now();
      const wait = start + (i + 1) * 20 - performance.now();
      if (wait > 0) await sleep(wait);
    }
    const deadline = performance.now() + REPLY_TIMEOUT_MS;
    while (loudSince < lastVoicedSent && performance.now() < deadline) await sleep(5);
    if (loudSince < lastVoicedSent) {
      misses++;
      continue;
    }
    delays.push(loudSince - lastVoicedSent);
    // Wait for the reply to finish, then pause like a person would.
    while (performance.now() - lastLoud < 600) await sleep(20);
    await sleep(500 + Math.random() * 500);
  }
  await link.close();
  await janus.close();
  decoder.delete();
  return { delays, misses };
}

const rooms = (process.argv[2] ?? '').split(',').map(Number);
const turns = Number(process.argv[3] ?? 5);
// Stagger starts so the rooms do not all speak in lockstep.
const results = await Promise.all(
  rooms.map(async (room, i) => {
    await sleep(i * 137);
    return runUser(room, turns);
  }),
);
process.send!({
  delays: results.flatMap((r) => r.delays),
  misses: results.reduce((n, r) => n + r.misses, 0),
});
encoder.delete();

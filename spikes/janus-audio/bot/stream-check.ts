/**
 * Is the room mix that Janus sends out smooth? Joins a room as a plain-RTP participant on the
 * server itself (no internet in between), speaks once so the bot replies, and records how the
 * mix arrives: packet spacing, RTP timestamp steps, sequence gaps and silent stretches.
 *
 *   npx tsx stream-check.ts [room=1001] [seconds=12]
 */
import { FRAME_SAMPLES, createOpus, rmsDbfs, synthesize, toInt16 } from './audio.js';
import { connectJanus, log, percentile } from './common.js';
import { joinPlainRtp } from './transport-a.js';
import { sleep } from './turn-bot.js';

const room = Number(process.argv[2] ?? 1001);
const seconds = Number(process.argv[3] ?? 12);

const clip = synthesize('Can you hear me? I am testing the audio path in this room.');
const encoder = createOpus();
const decoder = createOpus();

const janus = await connectJanus();
const link = await joinPlainRtp(janus, room, 'stream check');

const arrivals: number[] = [];
const levels: number[] = [];
link.onOpus((payload) => {
  arrivals.push(performance.now());
  try {
    levels.push(rmsDbfs(toInt16(decoder.decode(payload))));
  } catch {
    levels.push(-100);
  }
});

// Speak once (paced 20 ms frames) so the bot answers, then keep listening.
const start = performance.now();
for (let i = 0; i * FRAME_SAMPLES < clip.length; i++) {
  const pcm = new Int16Array(FRAME_SAMPLES);
  pcm.set(clip.subarray(i * FRAME_SAMPLES, (i + 1) * FRAME_SAMPLES));
  link.send(
    Buffer.from(encoder.encode(Buffer.from(pcm.buffer), FRAME_SAMPLES)),
    FRAME_SAMPLES,
    i === 0,
  );
  const wait = start + (i + 1) * 20 - performance.now();
  if (wait > 0) await sleep(wait);
}
await sleep(seconds * 1000);

const gaps = arrivals.slice(1).map((t, i) => t - arrivals[i]!);
const loud = levels.filter((l) => l > -45).length;
log('stream-check', 'result', {
  room,
  seconds: Math.round((performance.now() - start) / 1000),
  packets: arrivals.length,
  expectedAt50pps: Math.round(((performance.now() - start) / 1000) * 50),
  gapMs: {
    p50: Number(percentile(gaps, 50).toFixed(1)),
    p95: Number(percentile(gaps, 95).toFixed(1)),
    p99: Number(percentile(gaps, 99).toFixed(1)),
    max: Number(Math.max(...gaps).toFixed(1)),
  },
  gapsOver40ms: gaps.filter((g) => g > 40).length,
  gapsOver100ms: gaps.filter((g) => g > 100).length,
  loudFrames: loud,
});
await link.close();
await janus.close();
encoder.delete();
decoder.delete();
process.exit(0);

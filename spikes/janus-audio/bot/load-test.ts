/**
 * Load test: N rooms, each with one bot (prototype a or b) and one scripted candidate. Reports
 * the end-of-speech -> reply delay heard in the room, and the CPU of the bot process and Janus.
 * Run on the media server.
 *
 *   npx tsx load-test.ts a|b <rooms> [turns=5] [prebuffer=6]
 */
import { execSync, fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { cpuSampler, log } from './audio.js';
import { connectJanus, createRoom, env, percentile, replyAudio } from './common.js';
import { joinPlainRtp } from './transport-a.js';
import { joinWebRtc } from './transport-b.js';
import { TurnBot, botOptionsFromEnv, counters } from './turn-bot.js';
import type { TurnMetrics } from './turn-bot.js';

const kind = process.argv[2] === 'b' ? 'b' : 'a';
const roomCount = Number(process.argv[3] ?? 1);
const turns = Number(process.argv[4] ?? 5);
const prebuffer = Number(process.argv[5] ?? 6);
if (!env.adminKey) throw new Error('Set AUDIOBRIDGE_ADMIN_KEY');

/** utime + stime of a process in ms (Linux /proc, 100 ticks per second). */
function procCpuMs(pid: number): number {
  const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]!.split(' ');
  return (Number(fields[11]) + Number(fields[12])) * 10;
}
const janusPid = Number(execSync('pidof janus').toString().trim().split(' ')[0]);

const reply = replyAudio();
const admin = await connectJanus();
const rooms = Array.from({ length: roomCount }, (_, i) => 50_000 + i);
const created = await Promise.all(
  rooms.map((room) => createRoom(admin, room, randomBytes(8).toString('hex'), prebuffer)),
);

const bots: TurnBot[] = [];
const turnMetrics: TurnMetrics[] = [];
const join = kind === 'a' ? joinPlainRtp : joinWebRtc;
for (const room of rooms) {
  const janus = await connectJanus();
  const bot = new TurnBot(await join(janus, room, 'bot'), botOptionsFromEnv(reply));
  bot.onTurn = (m) => turnMetrics.push(m);
  bots.push(bot);
}
log(kind, 'setup done', { rooms: roomCount, turns, prebuffer });

const sample = cpuSampler();
const janusCpu0 = procCpuMs(janusPid);
const t0 = performance.now();
const users = fork(new URL('./fake-users.ts', import.meta.url), [rooms.join(','), String(turns)], {
  execArgv: ['--import', 'tsx'],
});
const result = await new Promise<{ delays: number[]; misses: number }>((resolve) =>
  users.once('message', (m) => resolve(m as { delays: number[]; misses: number })),
);
const elapsed = performance.now() - t0;
const botUsage = sample();
const janusCpuPct = ((procCpuMs(janusPid) - janusCpu0) / elapsed) * 100;

const { hangoverMs } = botOptionsFromEnv(reply);
const botMs = turnMetrics.map((m) => m.botMs);
log(kind, 'summary', {
  transport: kind === 'a' ? 'plain RTP' : 'WebRTC (werift)',
  rooms: roomCount,
  prebuffer,
  roomRate: Number(process.env.ROOM_RATE ?? 48_000),
  hangoverMs,
  measuredTurns: result.delays.length,
  misses: result.misses,
  heardDelayMs: {
    p50: Math.round(percentile(result.delays, 50)),
    p95: Math.round(percentile(result.delays, 95)),
    max: Math.round(Math.max(...result.delays)),
  },
  overheadBeyondHangoverMs: {
    p50: Math.round(percentile(result.delays, 50) - hangoverMs),
    p95: Math.round(percentile(result.delays, 95) - hangoverMs),
  },
  botProcessingMs: { p50: percentile(botMs, 50), p95: percentile(botMs, 95) },
  botProcessCpuPctOfCore: botUsage.cpuPctOfCore,
  botCpuPerRoomPct: Number((botUsage.cpuPctOfCore / roomCount).toFixed(2)),
  janusCpuPctOfCore: Number(janusCpuPct.toFixed(1)),
  botRssMb: botUsage.rssMb,
  ...counters,
});

for (const bot of bots) await bot.stop();
await Promise.all(created.map((r) => r.destroy()));
await admin.close();
process.exit(0);

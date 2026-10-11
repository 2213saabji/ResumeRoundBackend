/**
 * One bot in a room, for talking to it from the browser test page.
 *
 *   npx tsx run-bot.ts a|b [room=1001]
 */
import { cpuSampler, log } from './audio.js';
import { connectJanus, onExit, replyAudio } from './common.js';
import { joinPlainRtp } from './transport-a.js';
import { joinWebRtc } from './transport-b.js';
import { TurnBot, botOptionsFromEnv, counters } from './turn-bot.js';

const kind = process.argv[2] === 'b' ? 'b' : 'a';
const room = Number(process.argv[3] ?? 1001);
const label = kind === 'a' ? 'A-plain-rtp' : 'B-webrtc';

const reply = replyAudio();
const janus = await connectJanus();
const join = kind === 'a' ? joinPlainRtp : joinWebRtc;
const link = await join(janus, room, `bot (${label})`);
log(label, 'joined', {
  room,
  participant: link.participantId,
  replyMs: Math.round(reply.length / 48),
});

const bot = new TurnBot(link, botOptionsFromEnv(reply));
bot.onTurn = (m) => log(label, 'turn', { ...m });
const sample = cpuSampler();
const usage = setInterval(
  () => log(label, 'usage', { ...sample(), ...counters, ...bot.takeArrivalStats() }),
  10_000,
);

onExit(async () => {
  clearInterval(usage);
  await bot.stop();
  await janus.close();
});

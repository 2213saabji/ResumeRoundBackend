import { log, synthesize } from './audio.js';
import { JanusWs, signJanusToken } from './janus-ws.js';

export const AUDIOBRIDGE = 'janus.plugin.audiobridge';
export const OPUS_PT = 111;

export const env = {
  wsUrl: process.env.JANUS_WS_URL ?? 'ws://127.0.0.1:8188',
  tokenSecret: process.env.JANUS_TOKEN_SECRET ?? '',
  adminKey: process.env.AUDIOBRIDGE_ADMIN_KEY ?? '',
  /** Address Janus can send plain RTP to (the server's private IP). */
  rtpIp: process.env.BOT_RTP_IP ?? '127.0.0.1',
  replyText:
    process.env.REPLY_TEXT ??
    'Thanks. That makes sense. Now tell me how you would test that change before shipping it.',
};

export async function connectJanus(): Promise<JanusWs> {
  if (!env.tokenSecret) throw new Error('Set JANUS_TOKEN_SECRET');
  const janus = new JanusWs(env.wsUrl, () => signJanusToken(env.tokenSecret, [AUDIOBRIDGE], 300));
  await janus.connect();
  return janus;
}

export async function attachAudioBridge(janus: JanusWs) {
  return janus.attach(AUDIOBRIDGE);
}

let replyClip: Int16Array | undefined;
export function replyAudio(): Int16Array {
  replyClip ??= synthesize(env.replyText);
  return replyClip;
}

/** Creates a throwaway room (load test). Needs the AudioBridge admin key. */
export async function createRoom(janus: JanusWs, room: number, secret: string, prebuffer: number) {
  const handle = await attachAudioBridge(janus);
  await handle.message({
    request: 'create',
    admin_key: env.adminKey,
    room,
    secret,
    sampling_rate: Number(process.env.ROOM_RATE ?? 48_000),
    allow_rtp_participants: true,
    default_prebuffering: prebuffer,
    is_private: true,
  });
  return {
    destroy: () => handle.message({ request: 'destroy', room, secret }).catch(() => {}),
  };
}

export function onExit(fn: () => Promise<void> | void) {
  const stop = async () => {
    await fn();
    process.exit(0);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

export { log };

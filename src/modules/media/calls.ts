import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../../common/config.js';
import { Errors } from '../../common/errors.js';
import { logger } from '../../common/logger.js';
import { elapsedSec } from '../interviews/loop.js';
import type { Interview } from '../interviews/model.js';
import { interviewsRepository } from '../interviews/repository.js';
import { signJanusToken, turnCredentials } from './janus-auth.js';
import { AUDIOBRIDGE_PLUGIN, JanusClient, TEXTROOM_PLUGIN } from './janus-client.js';
import { botRegistry } from './bot-registry.js';

/** What the candidate's browser needs to join the call (docs/FRONTEND_INTEGRATION.md 7.6). */
export interface JoinInfo {
  wsUrl: string;
  token: string;
  room: number;
  pin: string;
  captionRoom: number;
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
}

export interface CallSettings {
  wsUrl: string;
  tokenSecret: string;
  turnUrls: string[];
  turnSecret?: string;
  janus: Pick<JanusClient, 'createAudioRoom' | 'createTextRoom'>;
}

/** Tokens and TURN credentials outlive the interview by this much (reconnects near the end). */
const CALL_MARGIN_SEC = 15 * 60;

let settings: CallSettings | null | undefined;

function settingsFromConfig(): CallSettings | null {
  const c = config;
  if (
    !c.JANUS_HTTP_URL ||
    !c.JANUS_WS_URL ||
    !c.JANUS_TOKEN_SECRET ||
    !c.AUDIOBRIDGE_ADMIN_KEY ||
    !c.TEXTROOM_ADMIN_KEY
  ) {
    return null;
  }
  return {
    wsUrl: c.JANUS_WS_URL,
    tokenSecret: c.JANUS_TOKEN_SECRET,
    turnUrls: c.TURN_URLS,
    turnSecret: c.TURN_SECRET,
    janus: new JanusClient(c.JANUS_HTTP_URL, {
      tokenSecret: c.JANUS_TOKEN_SECRET,
      audioBridgeAdminKey: c.AUDIOBRIDGE_ADMIN_KEY,
      textRoomAdminKey: c.TEXTROOM_ADMIN_KEY,
    }),
  };
}

function callSettings(): CallSettings | null {
  if (settings === undefined) settings = settingsFromConfig();
  return settings;
}

/** Test hook: replace the Janus settings (null = voice calls not configured). */
export function setCallSettings(s: CallSettings | null): void {
  settings = s;
}

/** STUN entries as they are; TURN entries share one set of time-limited credentials. */
export function iceServers(
  urls: string[],
  turn?: { username: string; credential: string },
): JoinInfo['iceServers'] {
  const stun = urls.filter((u) => u.startsWith('stun:'));
  const relays = urls.filter((u) => u.startsWith('turn:') || u.startsWith('turns:'));
  return [
    ...stun.map((u) => ({ urls: u })),
    ...(relays.length > 0 && turn ? [{ urls: relays, ...turn }] : []),
  ];
}

/** The interview's room; created on first join, recreated if Janus forgot it (restart). */
async function ensureRoom(
  s: CallSettings,
  interview: Interview,
): Promise<{ roomId: number; roomSecret: string; roomPin: string }> {
  const id = interview._id.toString();
  let room =
    interview.janus?.roomId && interview.janus.roomSecret && interview.janus.roomPin
      ? {
          roomId: interview.janus.roomId,
          roomSecret: interview.janus.roomSecret,
          roomPin: interview.janus.roomPin,
        }
      : null;
  if (!room) {
    const fresh = {
      roomId: randomInt(100_000_000, 2_000_000_000),
      roomSecret: randomBytes(24).toString('base64url'),
      roomPin: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    };
    // Two joins at once (double click, two tabs): exactly one stores its room.
    if (await interviewsRepository.claimCallRoom(id, fresh)) room = fresh;
    else {
      const stored = (await interviewsRepository.findById(id))?.janus;
      if (!stored?.roomId || !stored.roomSecret || !stored.roomPin) {
        throw Errors.unavailable('Could not prepare the call room; try again');
      }
      room = { roomId: stored.roomId, roomSecret: stored.roomSecret, roomPin: stored.roomPin };
    }
  }

  const spec = {
    roomId: room.roomId,
    secret: room.roomSecret,
    pin: room.roomPin,
    description: `interview ${id}`,
  };
  try {
    await s.janus.createAudioRoom({ ...spec, prebuffer: config.JANUS_ROOM_PREBUFFER });
    await s.janus.createTextRoom(spec);
  } catch (err) {
    logger.error({ err, interviewId: id }, 'could not create the call rooms');
    throw Errors.unavailable('Voice is not available right now');
  }
  return room;
}

/** Keeps the interview's bot if it is alive, otherwise assigns the least-loaded live bot. */
async function ensureBot(interview: Interview): Promise<string> {
  const staleMs = config.BOT_HEARTBEAT_MS * 3;
  const current = interview.janus?.botId;
  if (current && (await botRegistry.isAlive(current, staleMs))) return current;
  const bot = await botRegistry.pickLeastLoaded(staleMs);
  if (!bot) throw Errors.unavailable('Voice is busy right now');
  await interviewsRepository.assignBot(interview._id.toString(), bot.botId);
  return bot.botId;
}

/**
 * Prepares the live call for an interview the user owns and has started: the rooms, a bot,
 * and short-lived credentials for the browser. Safe to call again (reconnects): the same
 * rooms are reused and fresh credentials are issued.
 */
export async function joinCall(interview: Interview): Promise<JoinInfo> {
  if (interview.mode !== 'voice') throw Errors.conflict('This interview is in text mode');
  if (interview.status === 'created') throw Errors.conflict('Start the interview first');
  if (interview.status !== 'in_progress') throw Errors.conflict('This interview has ended');

  const s = callSettings();
  if (!s) throw Errors.unavailable('Voice calls are not configured on this server');

  const room = await ensureRoom(s, interview);
  await ensureBot(interview);

  const remaining = Math.max(0, interview.durationSec - elapsedSec(interview));
  const ttl = remaining + CALL_MARGIN_SEC;
  const turn = s.turnSecret
    ? turnCredentials({ secret: s.turnSecret, user: interview._id.toString(), ttlSeconds: ttl })
    : undefined;
  return {
    wsUrl: s.wsUrl,
    token: signJanusToken({
      secret: s.tokenSecret,
      plugins: [AUDIOBRIDGE_PLUGIN, TEXTROOM_PLUGIN],
      ttlSeconds: ttl,
    }),
    room: room.roomId,
    pin: room.roomPin,
    captionRoom: room.roomId,
    iceServers: iceServers(
      s.turnUrls,
      turn && { username: turn.username, credential: turn.credential },
    ),
  };
}

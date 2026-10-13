import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.js';
import { InterviewModel } from '../../src/modules/interviews/model.js';
import { botRegistry } from '../../src/modules/media/bot-registry.js';
import { iceServers, setCallSettings, type CallSettings } from '../../src/modules/media/calls.js';
import { useTestDb } from '../helpers/db.js';
import { createdInterview, startedInterview } from '../helpers/interviews.js';

useTestDb();
const app = createApp();

interface RoomSpec {
  roomId: number;
  secret: string;
  pin: string;
  description: string;
}

function fakeJanus() {
  return {
    createAudioRoom: vi.fn(async (o: RoomSpec) => ({ roomId: o.roomId })),
    createTextRoom: vi.fn(async (o: RoomSpec) => ({ roomId: o.roomId })),
  };
}

function configure(janus = fakeJanus()): ReturnType<typeof fakeJanus> {
  const settings: CallSettings = {
    wsUrl: 'ws://janus.test:8188',
    tokenSecret: 'test-token-secret',
    turnUrls: ['stun:janus.test:3478', 'turn:janus.test:3478?transport=udp'],
    turnSecret: 'test-turn-secret',
    janus,
  };
  setCallSettings(settings);
  return janus;
}

const bot = (botId = 'bot-1') =>
  botRegistry.heartbeat({ botId, host: 'test', capacity: 5, activeInterviews: 0 });

const join = (ctx: { id: string; auth: Record<string, string> }) =>
  request(app).post(`/api/v1/interviews/${ctx.id}/join`).set(ctx.auth);

describe('POST /interviews/:id/join', () => {
  afterEach(() => setCallSettings(null));

  it('needs a started voice interview', async () => {
    configure();
    await bot();
    const created = await createdInterview(app, 'voice');
    expect((await join(created)).status).toBe(409);

    const text = await startedInterview(app, 'text');
    const res = await join(text);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toContain('text mode');
  });

  it('is 503 when voice is not configured, or no bot is free', async () => {
    const ctx = await startedInterview(app, 'voice');
    expect((await join(ctx)).status).toBe(503);

    configure();
    await bot();
    await botRegistry.remove('bot-1');
    const busy = await join(ctx);
    expect(busy.status).toBe(503);
    expect(busy.body.error.message).toContain('busy');
  });

  it('returns the room, credentials and ICE servers, and reuses the room on rejoin', async () => {
    const janus = configure();
    await bot('bot-7');
    const ctx = await startedInterview(app, 'voice');

    const first = await join(ctx);
    expect(first.status).toBe(200);
    const body = first.body;
    expect(body).toMatchObject({ wsUrl: 'ws://janus.test:8188' });
    expect(body.room).toBeGreaterThan(0);
    expect(body.captionRoom).toBe(body.room);
    expect(body.pin).toMatch(/^\d{6}$/);
    expect(body.token).toMatch(/,janus,janus\.plugin\.audiobridge,janus\.plugin\.textroom:/);
    expect(body.iceServers).toEqual([
      { urls: 'stun:janus.test:3478' },
      {
        urls: ['turn:janus.test:3478?transport=udp'],
        username: expect.stringMatching(new RegExp(`^\\d+:${ctx.id}$`)),
        credential: expect.any(String),
      },
    ]);
    // The token lasts the rest of the interview (15 min) plus a 15 min margin.
    const expiry = Number(body.token.split(',')[0]);
    expect(expiry - Date.now() / 1000).toBeGreaterThan(29 * 60);

    const created = janus.createAudioRoom.mock.calls[0]![0];
    expect(created.pin).toBe(body.pin);
    expect(janus.createTextRoom).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: body.room, secret: created.secret, pin: body.pin }),
    );
    expect(JSON.stringify(body)).not.toContain(created.secret); // the room secret stays private

    const stored = await InterviewModel.findById(ctx.id).lean();
    expect(stored?.janus).toMatchObject({ roomId: body.room, botId: 'bot-7' });

    const again = await join(ctx);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ room: body.room, pin: body.pin });
    expect(janus.createAudioRoom).toHaveBeenCalledTimes(2); // re-created in case Janus restarted
  });

  it('turns a Janus failure into 503', async () => {
    const janus = fakeJanus();
    janus.createAudioRoom.mockRejectedValueOnce(new Error('Janus HTTP 502'));
    configure(janus);
    await bot();
    const ctx = await startedInterview(app, 'voice');
    const res = await join(ctx);
    expect(res.status).toBe(503);
  });

  it('is 404 for someone else’s interview', async () => {
    configure();
    await bot();
    const owner = await startedInterview(app, 'voice');
    const other = await createdInterview(app, 'voice');
    const res = await request(app).post(`/api/v1/interviews/${owner.id}/join`).set(other.auth);
    expect(res.status).toBe(404);
  });
});

describe('iceServers', () => {
  it('omits TURN without credentials', () => {
    expect(iceServers(['stun:a:3478', 'turn:a:3478'])).toEqual([{ urls: 'stun:a:3478' }]);
  });
});

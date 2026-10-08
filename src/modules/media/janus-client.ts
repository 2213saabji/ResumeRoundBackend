import { randomBytes } from 'node:crypto';
import { signJanusToken } from './janus-auth.js';

interface JanusResponse {
  janus: string;
  transaction?: string;
  data?: { id: number };
  plugindata?: { plugin: string; data: Record<string, unknown> };
  error?: { code: number; reason: string };
}

export const AUDIOBRIDGE_PLUGIN = 'janus.plugin.audiobridge';
export const TEXTROOM_PLUGIN = 'janus.plugin.textroom';

/** Lifetime of the token signed for each backend request (it is only used once). */
const REQUEST_TOKEN_TTL_SECONDS = 60;

export interface JanusClientOptions {
  /** Janus `token_auth_secret`. Without it only `info()` works. */
  tokenSecret?: string;
  /** AudioBridge `admin_key`: needed to create rooms and to forward RTP. */
  audioBridgeAdminKey?: string;
}

/**
 * Minimal client for the Janus HTTP REST transport, used by the backend to manage rooms.
 * Every request carries a freshly signed, short-lived token; the token secret and the plugin
 * admin keys never leave the backend, and the Janus admin API stays on localhost.
 */
export class JanusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly opts: JanusClientOptions = {},
  ) {}

  private token(): string {
    if (!this.opts.tokenSecret) throw new Error('JANUS_TOKEN_SECRET is not configured');
    return signJanusToken({
      secret: this.opts.tokenSecret,
      plugins: [AUDIOBRIDGE_PLUGIN, TEXTROOM_PLUGIN],
      ttlSeconds: REQUEST_TOKEN_TTL_SECONDS,
    });
  }

  private adminKey(): string {
    if (!this.opts.audioBridgeAdminKey) throw new Error('AUDIOBRIDGE_ADMIN_KEY is not configured');
    return this.opts.audioBridgeAdminKey;
  }

  private async post(path: string, body: Record<string, unknown>): Promise<JanusResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        transaction: randomBytes(8).toString('hex'),
        token: this.token(),
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`Janus HTTP ${res.status}`);
    const json = (await res.json()) as JanusResponse;
    if (json.janus === 'error' || json.error) {
      throw new Error(`Janus error ${json.error?.code}: ${json.error?.reason}`);
    }
    return json;
  }

  async info(): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}/info`, { signal: AbortSignal.timeout(2_000) });
    if (!res.ok) throw new Error(`Janus HTTP ${res.status}`);
    return res.json();
  }

  private async withPluginHandle<T>(plugin: string, fn: (path: string) => Promise<T>): Promise<T> {
    const session = await this.post('', { janus: 'create' });
    const sessionId = session.data!.id;
    try {
      const handle = await this.post(`/${sessionId}`, { janus: 'attach', plugin });
      return await fn(`/${sessionId}/${handle.data!.id}`);
    } finally {
      await this.post(`/${sessionId}`, { janus: 'destroy' }).catch(() => {});
    }
  }

  /** Synchronous AudioBridge request; throws unless the plugin replies with `expected`. */
  private async audioBridge(
    body: Record<string, unknown>,
    expected: string,
  ): Promise<Record<string, unknown>> {
    return this.withPluginHandle(AUDIOBRIDGE_PLUGIN, async (path) => {
      const res = await this.post(path, { janus: 'message', body });
      const data = res.plugindata?.data;
      if (!data || data.audiobridge !== expected) {
        throw new Error(`AudioBridge ${String(body.request)} failed: ${JSON.stringify(data)}`);
      }
      return data;
    });
  }

  /** Creates a private AudioBridge room protected by a per-room secret and PIN. */
  async createAudioRoom(opts: {
    roomId: number;
    secret: string;
    pin: string;
    description: string;
    samplingRate?: number;
  }) {
    await this.audioBridge(
      {
        request: 'create',
        admin_key: this.adminKey(),
        room: opts.roomId,
        description: opts.description,
        secret: opts.secret,
        pin: opts.pin,
        is_private: true,
        audiolevel_event: true,
        sampling_rate: opts.samplingRate ?? 16000,
        // 2 packets (40 ms) of jitter buffer per participant instead of 6: the spike measured
        // a p95 of about 100 ms added delay instead of 290 ms, with no lost turns.
        default_prebuffering: 2,
      },
      'created',
    );
    return { roomId: opts.roomId };
  }

  async destroyAudioRoom(roomId: number, secret: string): Promise<void> {
    await this.audioBridge({ request: 'destroy', room: roomId, secret }, 'destroyed');
  }

  /**
   * Forwards the room mix as plain RTP (Opus) to host:port, e.g. to the interview bot.
   * `lock_rtp_forward` is on, so this needs the admin key as well as the room secret.
   */
  async rtpForward(opts: {
    roomId: number;
    secret: string;
    host: string;
    port: number;
  }): Promise<{ streamId: number }> {
    const data = await this.audioBridge(
      {
        request: 'rtp_forward',
        admin_key: this.adminKey(),
        room: opts.roomId,
        secret: opts.secret,
        host: opts.host,
        port: opts.port,
        codec: 'opus',
      },
      'success',
    );
    return { streamId: Number(data.stream_id) };
  }

  async stopRtpForward(roomId: number, secret: string, streamId: number): Promise<void> {
    await this.audioBridge(
      {
        request: 'stop_rtp_forward',
        admin_key: this.adminKey(),
        room: roomId,
        secret,
        stream_id: streamId,
      },
      'success',
    );
  }
}

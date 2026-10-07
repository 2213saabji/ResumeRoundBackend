import { randomBytes } from 'node:crypto';

interface JanusResponse {
  janus: string;
  transaction?: string;
  data?: { id: number };
  plugindata?: { plugin: string; data: Record<string, unknown> };
  error?: { code: number; reason: string };
}

/**
 * Minimal client for the Janus HTTP REST transport, used by the API to manage rooms.
 * The API secret never leaves the backend; the admin port stays on the private network.
 * (MVP-4: wire into POST /interviews/:id/join.)
 */
export class JanusClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiSecret?: string,
  ) {}

  private async post(path: string, body: Record<string, unknown>): Promise<JanusResponse> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...body,
        transaction: randomBytes(8).toString('hex'),
        ...(this.apiSecret ? { apisecret: this.apiSecret } : {}),
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

  /** Creates an AudioBridge room protected by a per-room secret and PIN. */
  async createAudioRoom(opts: {
    roomId: number;
    secret: string;
    pin: string;
    description: string;
  }) {
    return this.withPluginHandle('janus.plugin.audiobridge', async (path) => {
      const res = await this.post(path, {
        janus: 'message',
        body: {
          request: 'create',
          room: opts.roomId,
          description: opts.description,
          secret: opts.secret,
          pin: opts.pin,
          is_private: true,
          audiolevel_event: true,
          sampling_rate: 16000,
        },
      });
      const data = res.plugindata?.data;
      if (!data || data.audiobridge !== 'created') {
        throw new Error(`AudioBridge create failed: ${JSON.stringify(data)}`);
      }
      return { roomId: opts.roomId };
    });
  }

  async destroyAudioRoom(roomId: number, secret: string): Promise<void> {
    await this.withPluginHandle('janus.plugin.audiobridge', (path) =>
      this.post(path, { janus: 'message', body: { request: 'destroy', room: roomId, secret } }),
    );
  }
}

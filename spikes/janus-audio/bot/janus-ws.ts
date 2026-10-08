import { createHmac, randomBytes } from 'node:crypto';

/** Same format as src/modules/media/janus-auth.ts (copied so the spike is self-contained). */
export function signJanusToken(secret: string, plugins: string[], ttlSeconds: number): string {
  const data = [Math.floor(Date.now() / 1000) + ttlSeconds, 'janus', ...plugins].join(',');
  return `${data}:${createHmac('sha1', secret).update(data).digest('base64')}`;
}

export interface JanusMessage {
  janus: string;
  transaction?: string;
  sender?: number;
  data?: { id: number };
  plugindata?: { plugin: string; data: Record<string, unknown> };
  jsep?: { type: 'offer' | 'answer'; sdp: string };
  candidate?: { candidate?: string; sdpMid?: string; sdpMLineIndex?: number; completed?: boolean };
  error?: { code: number; reason: string };
}

interface Pending {
  resolve: (msg: JanusMessage) => void;
  reject: (err: Error) => void;
  ackOnly: boolean;
}

/** Minimal Janus WebSocket client (Node 22 global WebSocket). */
export class JanusWs {
  private ws!: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private keepalive?: NodeJS.Timeout;
  sessionId = 0;
  onEvent: (msg: JanusMessage) => void = () => {};

  constructor(
    private readonly url: string,
    private readonly token: () => string,
  ) {}

  async connect(): Promise<void> {
    this.ws = new WebSocket(this.url, 'janus-protocol');
    await new Promise<void>((resolve, reject) => {
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`WebSocket error (${this.url})`));
    });
    this.ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as JanusMessage);
    this.ws.onclose = () => clearInterval(this.keepalive);
    const res = await this.send({ janus: 'create' });
    this.sessionId = res.data!.id;
    this.keepalive = setInterval(() => {
      this.send({ janus: 'keepalive', session_id: this.sessionId }, true).catch(() => {});
    }, 25_000);
  }

  private receive(msg: JanusMessage) {
    const p = msg.transaction ? this.pending.get(msg.transaction) : undefined;
    if (!p) return this.onEvent(msg);
    if (msg.janus === 'ack' && !p.ackOnly) return;
    this.pending.delete(msg.transaction!);
    if (msg.janus === 'error')
      return p.reject(new Error(`Janus ${msg.error?.code}: ${msg.error?.reason}`));
    const pluginError = msg.plugindata?.data.error;
    if (pluginError) return p.reject(new Error(`Plugin: ${String(pluginError)}`));
    p.resolve(msg);
  }

  send(msg: Record<string, unknown>, ackOnly = false): Promise<JanusMessage> {
    const transaction = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      this.pending.set(transaction, { resolve, reject, ackOnly });
      this.ws.send(JSON.stringify({ ...msg, transaction, token: this.token() }));
    });
  }

  async attach(plugin: string) {
    const res = await this.send({ janus: 'attach', session_id: this.sessionId, plugin });
    const handleId = res.data!.id;
    const base = { session_id: this.sessionId, handle_id: handleId };
    return {
      id: handleId,
      message: (body: Record<string, unknown>, jsep?: { type: string; sdp: string }) =>
        this.send({ janus: 'message', ...base, body, ...(jsep ? { jsep } : {}) }),
      trickle: (candidate: Record<string, unknown>) =>
        this.send({ janus: 'trickle', ...base, candidate }, true),
    };
  }

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    await this.send({ janus: 'destroy', session_id: this.sessionId }).catch(() => {});
    this.ws.close();
  }
}

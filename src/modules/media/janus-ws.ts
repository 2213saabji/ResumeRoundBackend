import { randomBytes } from 'node:crypto';

export interface JanusMessage {
  janus: string;
  transaction?: string;
  sender?: number;
  data?: { id: number };
  plugindata?: { plugin: string; data: Record<string, unknown> };
  jsep?: { type: 'offer' | 'answer'; sdp: string };
  error?: { code: number; reason: string };
}

export interface JanusHandle {
  id: number;
  message(
    body: Record<string, unknown>,
    jsep?: { type: string; sdp: string },
  ): Promise<JanusMessage>;
  detach(): Promise<void>;
}

interface Pending {
  resolve: (msg: JanusMessage) => void;
  reject: (err: Error) => void;
  /** Resolve on the `ack` (requests that only get an ack, e.g. keepalive). */
  ackOnly: boolean;
}

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Janus WebSocket API client for the interview bot: one session per bot process, one plugin
 * handle per room. Every message carries a freshly signed token, so tokens can stay
 * short-lived. Asynchronous plugin replies (e.g. the AudioBridge `join` answer) are matched to
 * their request by transaction id.
 */
export class JanusWs {
  private ws?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private keepalive?: NodeJS.Timeout;
  private sessionId = 0;
  /** Called once if the connection drops; the bot treats its calls as lost. */
  onClose: () => void = () => {};

  constructor(
    private readonly url: string,
    private readonly token: () => string,
  ) {}

  async connect(): Promise<void> {
    const ws = new WebSocket(this.url, 'janus-protocol');
    this.ws = ws;
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error(`Janus WebSocket error (${this.url})`));
    });
    ws.onmessage = (e) => this.receive(JSON.parse(String(e.data)) as JanusMessage);
    ws.onclose = () => {
      clearInterval(this.keepalive);
      for (const p of this.pending.values()) p.reject(new Error('Janus connection closed'));
      this.pending.clear();
      this.onClose();
    };
    const res = await this.send({ janus: 'create' });
    this.sessionId = res.data!.id;
    this.keepalive = setInterval(() => {
      this.send({ janus: 'keepalive', session_id: this.sessionId }, true).catch(() => {});
    }, 25_000);
  }

  private receive(msg: JanusMessage): void {
    const p = msg.transaction ? this.pending.get(msg.transaction) : undefined;
    if (!p) return; // unsolicited events (talking, slowlink...): the bot does not need them
    if (msg.janus === 'ack' && !p.ackOnly) return;
    this.pending.delete(msg.transaction!);
    if (msg.janus === 'error') {
      p.reject(new Error(`Janus ${msg.error?.code}: ${msg.error?.reason}`));
      return;
    }
    const data = msg.plugindata?.data;
    if (data?.error) {
      p.reject(new Error(`Janus plugin error ${String(data.error_code)}: ${String(data.error)}`));
      return;
    }
    p.resolve(msg);
  }

  private send(msg: Record<string, unknown>, ackOnly = false): Promise<JanusMessage> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Janus connection is not open'));
    }
    const transaction = randomBytes(8).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(transaction);
        reject(new Error(`Janus request timed out (${String(msg.janus)})`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(transaction, {
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
        ackOnly,
      });
      ws.send(JSON.stringify({ ...msg, transaction, token: this.token() }));
    });
  }

  async attach(plugin: string): Promise<JanusHandle> {
    const res = await this.send({ janus: 'attach', session_id: this.sessionId, plugin });
    const handleId = res.data!.id;
    const base = { session_id: this.sessionId, handle_id: handleId };
    return {
      id: handleId,
      message: (body, jsep) =>
        this.send({ janus: 'message', ...base, body, ...(jsep ? { jsep } : {}) }),
      detach: async () => {
        await this.send({ janus: 'detach', ...base }).catch(() => {});
      },
    };
  }

  async close(): Promise<void> {
    clearInterval(this.keepalive);
    this.onClose = () => {};
    if (this.ws?.readyState === WebSocket.OPEN) {
      await this.send({ janus: 'destroy', session_id: this.sessionId }).catch(() => {});
      this.ws.close();
    }
  }
}

/**
 * Does Janus check the token on every request, or only when the session is created? Creates a
 * session with a 5-second token, waits 8 seconds, then reuses the same token.
 *
 *   npx tsx spikes/janus-audio/token-lifetime.ts
 */
import { config } from '../../src/common/config.js';
import { signJanusToken } from '../../src/modules/media/janus-auth.js';

const url = config.JANUS_HTTP_URL!;
const token = signJanusToken({
  secret: config.JANUS_TOKEN_SECRET!,
  plugins: ['janus.plugin.audiobridge'],
  ttlSeconds: 5,
});

interface Reply {
  janus: string;
  data?: { id: number };
  error?: { code: number; reason: string };
}

async function post(path: string, body: Record<string, unknown>): Promise<Reply> {
  const res = await fetch(`${url}${path}`, {
    method: 'POST',
    body: JSON.stringify({ ...body, transaction: Math.random().toString(36).slice(2), token }),
  });
  return (await res.json()) as Reply;
}

const describe = (r: Reply) => (r.error ? `${r.janus} ${r.error.code} ${r.error.reason}` : r.janus);

const session = await post('', { janus: 'create' });
console.log('create:', describe(session));
await new Promise((r) => setTimeout(r, 8_000));
const sessionPath = `/${session.data!.id}`;
console.log('keepalive after expiry:', describe(await post(sessionPath, { janus: 'keepalive' })));
console.log(
  'attach after expiry:',
  describe(await post(sessionPath, { janus: 'attach', plugin: 'janus.plugin.audiobridge' })),
);

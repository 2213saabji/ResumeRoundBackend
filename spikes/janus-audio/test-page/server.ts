/**
 * Local test page for the Janus audio spike. Serves index.html and GET /config, which hands the
 * browser what the real POST /interviews/:id/join will: the Janus WebSocket URL, a short-lived
 * signed token limited to the plugins it needs, and ICE servers with time-limited TURN
 * credentials. Listens on localhost only (browsers allow the mic on http://localhost).
 *
 *   npx tsx spikes/janus-audio/test-page/server.ts   ->  http://localhost:8787
 */
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { config } from '../../../src/common/config.js';
import { signJanusToken, turnCredentials } from '../../../src/modules/media/janus-auth.js';

const PORT = 8787;
const TOKEN_TTL_SECONDS = 60 * 60;

if (!config.JANUS_WS_URL || !config.JANUS_TOKEN_SECRET) {
  throw new Error('Set JANUS_WS_URL and JANUS_TOKEN_SECRET (see .env.example)');
}
const { JANUS_WS_URL: wsUrl, JANUS_TOKEN_SECRET: tokenSecret } = config;

function browserConfig() {
  const iceServers: RTCIceServerLike[] = [];
  const stun = config.TURN_URLS.filter((u) => u.startsWith('stun:'));
  const turn = config.TURN_URLS.filter((u) => u.startsWith('turn:') || u.startsWith('turns:'));
  if (stun.length) iceServers.push({ urls: stun });
  if (turn.length && config.TURN_SECRET) {
    const creds = turnCredentials({
      secret: config.TURN_SECRET,
      user: 'spike',
      ttlSeconds: TOKEN_TTL_SECONDS,
    });
    iceServers.push({ urls: turn, username: creds.username, credential: creds.credential });
  }
  return {
    wsUrl,
    token: signJanusToken({
      secret: tokenSecret,
      plugins: ['janus.plugin.audiobridge', 'janus.plugin.echotest'],
      ttlSeconds: TOKEN_TTL_SECONDS,
    }),
    iceServers,
    room: 1001,
  };
}

interface RTCIceServerLike {
  urls: string[];
  username?: string;
  credential?: string;
}

const page = new URL('./index.html', import.meta.url);

createServer(async (req, res) => {
  if (req.url === '/config') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(browserConfig()));
    return;
  }
  if (req.url === '/' || req.url === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(await readFile(page));
    return;
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Janus audio spike test page: http://localhost:${PORT}  (Janus ${wsUrl})`);
});

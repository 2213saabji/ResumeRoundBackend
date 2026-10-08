/**
 * Live check of the backend's JanusClient against the dev media server: signed tokens, the
 * AudioBridge admin key, room create/destroy and RTP forwarding.
 *
 *   npx tsx spikes/janus-audio/smoke.ts
 */
import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../../src/common/config.js';
import { JanusClient } from '../../src/modules/media/janus-client.js';

if (!config.JANUS_HTTP_URL) throw new Error('Set JANUS_HTTP_URL (see .env.example)');

const janus = new JanusClient(config.JANUS_HTTP_URL, {
  tokenSecret: config.JANUS_TOKEN_SECRET,
  audioBridgeAdminKey: config.AUDIOBRIDGE_ADMIN_KEY,
});

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  const result = await fn();
  console.log(`ok  ${name} (${Math.round(performance.now() - t0)} ms)`);
  return result;
}

const info = (await step('info', () => janus.info())) as { version_string: string };
console.log(`    Janus ${info.version_string}`);

const roomId = randomInt(1_000_000, 2_000_000_000);
const secret = randomBytes(16).toString('hex');
await step('create room', () =>
  janus.createAudioRoom({ roomId, secret, pin: '1234', description: 'smoke test' }),
);
try {
  const { streamId } = await step('rtp_forward', () =>
    janus.rtpForward({ roomId, secret, host: '127.0.0.1', port: 40000 }),
  );
  await step('stop_rtp_forward', () => janus.stopRtpForward(roomId, secret, streamId));

  const noKey = new JanusClient(config.JANUS_HTTP_URL, {
    tokenSecret: config.JANUS_TOKEN_SECRET,
    audioBridgeAdminKey: 'wrong-key',
  });
  await step('rtp_forward with a wrong admin key is refused', () =>
    noKey.rtpForward({ roomId, secret, host: '127.0.0.1', port: 40000 }).then(
      () => {
        throw new Error('expected a refusal');
      },
      (err: Error) => console.log(`    ${err.message}`),
    ),
  );
} finally {
  await step('destroy room', () => janus.destroyAudioRoom(roomId, secret));
}

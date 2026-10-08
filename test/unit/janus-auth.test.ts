import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signJanusToken, turnCredentials } from '../../src/modules/media/janus-auth.js';

const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);
const NOW_S = NOW / 1000;

describe('signJanusToken', () => {
  it('produces the Janus signed-token format', () => {
    const token = signJanusToken({
      secret: 's3cret',
      plugins: ['janus.plugin.audiobridge', 'janus.plugin.textroom'],
      ttlSeconds: 60,
      now: NOW,
    });
    const [data, signature] = token.split(':');
    expect(data).toBe(`${NOW_S + 60},janus,janus.plugin.audiobridge,janus.plugin.textroom`);
    expect(signature).toBe(createHmac('sha1', 's3cret').update(data!).digest('base64'));
  });

  it('requires at least one plugin', () => {
    expect(() => signJanusToken({ secret: 's', plugins: [], ttlSeconds: 60 })).toThrow();
  });
});

describe('turnCredentials', () => {
  it('follows the TURN REST API scheme', () => {
    const creds = turnCredentials({ secret: 'turn', user: 'u1', ttlSeconds: 600, now: NOW });
    expect(creds.username).toBe(`${NOW_S + 600}:u1`);
    expect(creds.credential).toBe(
      createHmac('sha1', 'turn').update(creds.username).digest('base64'),
    );
    expect(creds.expiresAt.getTime()).toBe(NOW + 600_000);
  });
});

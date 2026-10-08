import { createHmac } from 'node:crypto';

/**
 * Signed Janus token (`token_auth_secret` mode): `<expiry>,janus,<plugin>[,<plugin>...]:<sig>`,
 * where sig = base64(HMAC-SHA1(secret, everything before the colon)). Janus checks the expiry
 * and that the token lists the plugin being attached, so a browser token for the AudioBridge
 * cannot be used for anything else. The secret never leaves the backend.
 */
export function signJanusToken(opts: {
  secret: string;
  plugins: string[];
  ttlSeconds: number;
  now?: number;
}): string {
  if (opts.plugins.length === 0) throw new Error('A Janus token needs at least one plugin');
  const expiry = Math.floor((opts.now ?? Date.now()) / 1000) + opts.ttlSeconds;
  const data = [expiry, 'janus', ...opts.plugins].join(',');
  const signature = createHmac('sha1', opts.secret).update(data).digest('base64');
  return `${data}:${signature}`;
}

export interface TurnCredentials {
  username: string;
  credential: string;
  expiresAt: Date;
}

/**
 * Time-limited TURN credentials (coturn `use-auth-secret`, the TURN REST API scheme):
 * username = `<expiry>:<user>`, credential = base64(HMAC-SHA1(secret, username)).
 */
export function turnCredentials(opts: {
  secret: string;
  user: string;
  ttlSeconds: number;
  now?: number;
}): TurnCredentials {
  const expiry = Math.floor((opts.now ?? Date.now()) / 1000) + opts.ttlSeconds;
  const username = `${expiry}:${opts.user}`;
  const credential = createHmac('sha1', opts.secret).update(username).digest('base64');
  return { username, credential, expiresAt: new Date(expiry * 1000) };
}

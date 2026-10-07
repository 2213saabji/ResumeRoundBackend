import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { useTestDb } from '../helpers/db.js';
import { registerUser } from '../helpers/fixtures.js';

useTestDb();
const app = createApp();

function refreshCookie(cookies: string[]): string {
  const c = cookies.find((x) => x.startsWith('rr_refresh='));
  if (!c) throw new Error('no refresh cookie');
  return c.split(';')[0]!;
}

describe('auth', () => {
  it('registers, sets an httpOnly refresh cookie and returns an access token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'Asha@Example.com', password: 'correct-horse-battery' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'asha@example.com',
      role: 'candidate',
      onboarded: false,
    });
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(res.body.user.passwordHash).toBeUndefined();
    const cookie = (res.headers['set-cookie'] as unknown as string[]).find((c) =>
      c.startsWith('rr_refresh='),
    );
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
  });

  it('rejects a duplicate email and invalid input', async () => {
    const { email } = await registerUser(app);
    const dup = await request(app)
      .post('/api/v1/auth/register')
      .send({ email, password: 'another-password' });
    expect(dup.status).toBe(409);

    const bad = await request(app)
      .post('/api/v1/auth/register')
      .send({ email: 'nope', password: 'short' });
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('VALIDATION_ERROR');
    expect(bad.body.error.requestId).toEqual(expect.any(String));
  });

  it('logs in with the right password only', async () => {
    const { email, password } = await registerUser(app);
    expect((await request(app).post('/api/v1/auth/login').send({ email, password })).status).toBe(
      200,
    );

    const wrong = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'wrong-password' });
    expect(wrong.status).toBe(401);
    const unknown = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'ghost@example.com', password });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe(wrong.body.error.message);
  });

  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const { cookies } = await registerUser(app);
    const first = refreshCookie(cookies);

    const r1 = await request(app).post('/api/v1/auth/refresh').set('Cookie', first);
    expect(r1.status).toBe(200);
    const second = refreshCookie(r1.headers['set-cookie'] as unknown as string[]);
    expect(second).not.toBe(first);

    // Replaying the rotated-out token is treated as theft: the session dies.
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', first)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', second)).status).toBe(
      401,
    );
  });

  it('logout invalidates the refresh token', async () => {
    const { cookies } = await registerUser(app);
    const cookie = refreshCookie(cookies);
    expect((await request(app).post('/api/v1/auth/logout').set('Cookie', cookie)).status).toBe(204);
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', cookie)).status).toBe(
      401,
    );
  });

  it('protects /me and completes onboarding via PATCH /me', async () => {
    expect((await request(app).get('/api/v1/me')).status).toBe(401);
    expect(
      (await request(app).get('/api/v1/me').set('Authorization', 'Bearer garbage')).status,
    ).toBe(401);

    const { accessToken } = await registerUser(app);
    const auth = { Authorization: `Bearer ${accessToken}` };

    const partial = await request(app)
      .patch('/api/v1/me')
      .set(auth)
      .send({ targetRole: 'backend' });
    expect(partial.body.user.onboarded).toBe(false);

    const done = await request(app)
      .patch('/api/v1/me')
      .set(auth)
      .send({ level: 'sde2', companyType: 'product' });
    expect(done.status).toBe(200);
    expect(done.body.user).toMatchObject({ targetRole: 'backend', level: 'sde2', onboarded: true });

    const unknownField = await request(app).patch('/api/v1/me').set(auth).send({ role: 'admin' });
    expect(unknownField.status).toBe(400);
  });

  it('serves health endpoints and a JSON 404', async () => {
    expect((await request(app).get('/healthz')).body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/readyz');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.mongodb).toBe('ok');
    const missing = await request(app).get('/api/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_FOUND');
  });
});

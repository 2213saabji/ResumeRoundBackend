import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { JobModel } from '../../src/modules/jobs/model.js';
import { CandidateProfileModel } from '../../src/modules/profiles/model.js';
import { useTestDb } from '../helpers/db.js';
import { registerUser } from '../helpers/fixtures.js';

useTestDb();
const app = createApp();

async function onboardedUserWithProfile() {
  const user = await registerUser(app);
  const auth = { Authorization: `Bearer ${user.accessToken}` };
  await request(app)
    .patch('/api/v1/me')
    .set(auth)
    .send({ targetRole: 'backend', level: 'senior', companyType: 'product' });
  await CandidateProfileModel.create({
    userId: user.userId,
    seniority: 'senior',
    experienceYears: 6,
    skills: {
      languages: ['Go'],
      frameworks: [],
      databases: ['PostgreSQL'],
      cloud: ['AWS'],
      architecture: ['event-driven'],
    },
    projects: [
      {
        name: 'Orders Platform',
        technologies: ['Go', 'PostgreSQL', 'Kafka'],
        description: '',
        scaleSignals: ['5k RPS'],
      },
    ],
  });
  return { ...user, auth };
}

describe('interviews', () => {
  let user: Awaited<ReturnType<typeof onboardedUserWithProfile>>;
  let interviewId: string;

  beforeAll(async () => {
    user = await onboardedUserWithProfile();
  });

  it('requires a parsed profile first', async () => {
    const fresh = await registerUser(app);
    const res = await request(app)
      .post('/api/v1/interviews')
      .set('Authorization', `Bearer ${fresh.accessToken}`)
      .send({ role: 'backend', level: 'sde2', companyType: 'startup' });
    expect(res.status).toBe(409);
  });

  it('creates an interview with a plan built from the profile and onboarding defaults', async () => {
    const res = await request(app)
      .post('/api/v1/interviews')
      .set(user.auth)
      .send({ durationMin: 30 });
    expect(res.status).toBe(201);
    const { interview } = res.body;
    interviewId = interview.id;
    expect(interview).toMatchObject({
      status: 'created',
      role: 'backend',
      level: 'senior',
      durationSec: 1800,
    });
    expect(interview.plan[1]).toMatchObject({
      kind: 'project_deep_dive',
      projectName: 'Orders Platform',
    });
    expect(interview.state.difficulty).toBeGreaterThanOrEqual(6); // senior band starts at 6

    const fetched = await request(app).get(`/api/v1/interviews/${interviewId}`).set(user.auth);
    expect(fetched.body.interview.id).toBe(interviewId);
  });

  it('reports 409 for the report of a live interview, 202 once ended while generating', async () => {
    expect(
      (await request(app).get(`/api/v1/interviews/${interviewId}/report`).set(user.auth)).status,
    ).toBe(409);

    const ended = await request(app).post(`/api/v1/interviews/${interviewId}/end`).set(user.auth);
    expect(ended.body.interview.status).toBe('ended');
    // Ending is idempotent and enqueues exactly one report job.
    await request(app).post(`/api/v1/interviews/${interviewId}/end`).set(user.auth);
    expect(
      await JobModel.countDocuments({
        type: 'report.generate',
        'payload.interviewId': interviewId,
      }),
    ).toBe(1);

    const report = await request(app)
      .get(`/api/v1/interviews/${interviewId}/report`)
      .set(user.auth);
    expect(report.status).toBe(202);
    expect(report.body).toEqual({ status: 'generating' });
  });

  it('paginates turns (empty for a new interview) and validates ids', async () => {
    const turns = await request(app)
      .get(`/api/v1/interviews/${interviewId}/turns?limit=10`)
      .set(user.auth);
    expect(turns.body).toEqual({ items: [], nextCursor: null });
    expect((await request(app).get('/api/v1/interviews/not-an-id').set(user.auth)).status).toBe(
      400,
    );
  });

  it('enforces the monthly free quota (3 in tests)', async () => {
    const statuses = [];
    for (let i = 0; i < 3; i++) {
      statuses.push((await request(app).post('/api/v1/interviews').set(user.auth).send({})).status);
    }
    expect(statuses).toEqual([201, 201, 403]);
  });

  it('exposes empty progress for a new user', async () => {
    const res = await request(app).get('/api/v1/users/me/progress').set(user.auth);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ skills: [], dimensions: [], overall: [] });
  });
});

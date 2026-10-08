import request from 'supertest';
import type { App } from 'supertest/types.js';
import { CandidateProfileModel } from '../../src/modules/profiles/model.js';
import { registerUser } from './fixtures.js';

export const ANSWER =
  'We put an API layer in front of Postgres and cached hot reads, then measured p95 latency before and after the change to confirm it helped under peak load from the batch jobs.';

export interface InterviewCtx {
  auth: Record<string, string>;
  id: string;
  userId: string;
}

/** A user with a parsed profile and a created (not started) 15-minute text interview. */
export async function createdInterview(app: App): Promise<InterviewCtx> {
  const user = await registerUser(app);
  const auth = { Authorization: `Bearer ${user.accessToken}` };
  await request(app)
    .patch('/api/v1/me')
    .set(auth)
    .send({ targetRole: 'backend', level: 'sde2', companyType: 'product' });
  await CandidateProfileModel.create({
    userId: user.userId,
    seniority: 'sde2',
    experienceYears: 4,
    skills: {
      languages: ['TypeScript'],
      frameworks: ['Node.js'],
      databases: ['PostgreSQL', 'Redis'],
      cloud: ['AWS'],
      architecture: ['microservices'],
    },
    projects: [
      {
        name: 'Payment Gateway',
        technologies: ['Node.js', 'Redis', 'Kafka'],
        description: 'Payments for a fintech startup',
        scaleSignals: ['2000 RPS'],
      },
    ],
  });
  const res = await request(app)
    .post('/api/v1/interviews')
    .set(auth)
    .send({ durationMin: 15, mode: 'text' });
  return { auth, id: res.body.interview.id as string, userId: user.userId };
}

export async function startedInterview(app: App) {
  const ctx = await createdInterview(app);
  const res = await request(app).post(`/api/v1/interviews/${ctx.id}/start`).set(ctx.auth);
  return { ...ctx, start: res };
}

export const answer = (app: App, ctx: InterviewCtx, seq: number, answerText = ANSWER) =>
  request(app).post(`/api/v1/interviews/${ctx.id}/answers`).set(ctx.auth).send({ seq, answerText });

/** Answers every question until the interview ends; returns the final response. */
export async function completeInterview(app: App, ctx: InterviewCtx, firstSeq = 1) {
  let seq: number | undefined = firstSeq;
  let last;
  for (let i = 0; i < 40 && seq; i++) {
    last = await answer(app, ctx, seq);
    if (last.status !== 200)
      throw new Error(`answer failed: ${last.status} ${JSON.stringify(last.body)}`);
    seq = last.body.currentTurn?.seq;
  }
  return last!;
}

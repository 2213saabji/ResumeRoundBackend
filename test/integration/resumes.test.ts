import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { logger } from '../../src/common/logger.js';
import { JobModel } from '../../src/modules/jobs/model.js';
import { jobQueue } from '../../src/modules/jobs/queue.js';
import { parseResumeJob } from '../../src/modules/resumes/jobs.js';
import { useTestDb } from '../helpers/db.js';
import { SAMPLE_RESUME_LINES, makePdf, registerUser } from '../helpers/fixtures.js';

useTestDb();
const app = createApp();

/** Runs the next queued resume.parse job inline, the way the worker process would. */
async function runNextParseJob() {
  const job = await jobQueue.claim('test-worker', ['resume.parse'], 60_000);
  if (!job) throw new Error('no resume.parse job queued');
  try {
    await parseResumeJob(job.payload as { resumeId: string }, {
      job,
      log: logger,
      isFinalAttempt: false,
    });
    await jobQueue.complete(job._id, 'test-worker');
  } catch (err) {
    await jobQueue.fail(job, 'test-worker', err);
  }
  return job;
}

describe('resume upload -> parse -> editable profile', () => {
  it('accepts a PDF with 202, parses it in the job and exposes an editable profile', async () => {
    const { accessToken } = await registerUser(app);
    const auth = { Authorization: `Bearer ${accessToken}` };

    const upload = await request(app)
      .post('/api/v1/resumes')
      .set(auth)
      .attach('file', makePdf(SAMPLE_RESUME_LINES), {
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      });
    expect(upload.status).toBe(202);
    expect(upload.body.resume.status).toBe('uploaded');
    const id = upload.body.resume.id as string;

    expect((await request(app).get('/api/v1/profiles/current').set(auth)).status).toBe(404);

    await runNextParseJob();

    const status = await request(app).get(`/api/v1/resumes/${id}`).set(auth);
    expect(status.body.resume).toMatchObject({ status: 'ready', error: null });

    const profile = await request(app).get('/api/v1/profiles/current').set(auth);
    expect(profile.status).toBe(200);
    expect(profile.body.profile.experienceYears).toBe(4);
    expect(profile.body.profile.skills.databases).toEqual(
      expect.arrayContaining(['PostgreSQL', 'Redis']),
    );
    expect(profile.body.profile.projects.map((p: { name: string }) => p.name)).toContain(
      'Ledger Service on PostgreSQL with double-entry bookkeeping',
    );

    const edited = await request(app)
      .patch('/api/v1/profiles/current')
      .set(auth)
      .send({
        skills: {
          languages: ['TypeScript', 'Go'],
          frameworks: [],
          databases: ['PostgreSQL'],
          cloud: [],
          architecture: [],
        },
      });
    expect(edited.status).toBe(200);
    expect(edited.body.profile).toMatchObject({
      editedByUser: true,
      skills: { languages: ['TypeScript', 'Go'] },
    });
  });

  it('rejects non-resume files by content, not by name', async () => {
    const { accessToken } = await registerUser(app);
    const res = await request(app)
      .post('/api/v1/resumes')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', Buffer.from('#!/bin/sh\necho pwned'), {
        filename: 'resume.pdf',
        contentType: 'application/pdf',
      });
    expect(res.status).toBe(415);
  });

  it('rejects files over 5 MB', async () => {
    const { accessToken } = await registerUser(app);
    const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const res = await request(app)
      .post('/api/v1/resumes')
      .set('Authorization', `Bearer ${accessToken}`)
      .attach('file', big, { filename: 'big.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(413);
  });

  it('marks a resume with no extractable text as failed without retrying', async () => {
    const { accessToken } = await registerUser(app);
    const auth = { Authorization: `Bearer ${accessToken}` };
    const upload = await request(app)
      .post('/api/v1/resumes')
      .set(auth)
      .attach('file', makePdf(['too short']), {
        filename: 'empty.pdf',
        contentType: 'application/pdf',
      });

    const job = await runNextParseJob();
    const res = await request(app).get(`/api/v1/resumes/${upload.body.resume.id}`).set(auth);
    expect(res.body.resume.status).toBe('failed');
    expect(res.body.resume.error).toMatch(/could not read any text/);
    expect((await JobModel.findById(job._id).lean())?.status).toBe('dead');
  });

  it("does not leak other users' resumes", async () => {
    const owner = await registerUser(app);
    const upload = await request(app)
      .post('/api/v1/resumes')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .attach('file', makePdf(SAMPLE_RESUME_LINES), {
        filename: 'r.pdf',
        contentType: 'application/pdf',
      });

    const other = await registerUser(app);
    const res = await request(app)
      .get(`/api/v1/resumes/${upload.body.resume.id}`)
      .set('Authorization', `Bearer ${other.accessToken}`);
    expect(res.status).toBe(404);
  });

  it('replays the original response for a repeated Idempotency-Key', async () => {
    const { accessToken } = await registerUser(app);
    const send = () =>
      request(app)
        .post('/api/v1/resumes')
        .set({ Authorization: `Bearer ${accessToken}`, 'Idempotency-Key': 'upload-key-0001' })
        .attach('file', makePdf(SAMPLE_RESUME_LINES), {
          filename: 'r.pdf',
          contentType: 'application/pdf',
        });

    const first = await send();
    // The key is persisted on response finish; give that write a moment.
    await new Promise((r) => setTimeout(r, 100));
    const second = await send();
    expect(second.status).toBe(202);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.resume.id).toBe(first.body.resume.id);
  });
});

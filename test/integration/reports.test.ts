import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { logger } from '../../src/common/logger.js';
import { setAiGateway } from '../../src/modules/ai/gateway.js';
import { MockProvider } from '../../src/modules/ai/providers/mock.js';
import { AiError } from '../../src/modules/ai/types.js';
import { InterviewModel } from '../../src/modules/interviews/model.js';
import { JobModel } from '../../src/modules/jobs/model.js';
import { jobQueue } from '../../src/modules/jobs/queue.js';
import { SkillHistoryModel } from '../../src/modules/progress/model.js';
import { ReportModel } from '../../src/modules/reports/model.js';
import { generateReportJob } from '../../src/modules/reports/service.js';
import { useTestDb } from '../helpers/db.js';
import {
  answer,
  completeInterview,
  createdInterview,
  startedInterview,
  type InterviewCtx,
} from '../helpers/interviews.js';

useTestDb();
const app = createApp();

afterEach(() => setAiGateway(new MockProvider()));

/** Runs every queued report job inline, the way the worker would; returns final statuses. */
async function runReportJobs(): Promise<string[]> {
  const outcomes: string[] = [];
  for (;;) {
    const job = await jobQueue.claim('test-worker', ['report.generate'], 60_000);
    if (!job) return outcomes;
    try {
      await generateReportJob(job.payload as { interviewId: string }, {
        job,
        log: logger,
        isFinalAttempt: job.attempts >= job.maxAttempts,
      });
      await jobQueue.complete(job._id, 'test-worker');
      outcomes.push('succeeded');
    } catch (err) {
      outcomes.push(await jobQueue.fail(job, 'test-worker', err));
    }
  }
}

const getReport = (ctx: InterviewCtx) =>
  request(app).get(`/api/v1/interviews/${ctx.id}/report`).set(ctx.auth);

describe('report generation', () => {
  it('generates the report after a completed interview and fills progress', async () => {
    const ctx = await startedInterview(app);
    await completeInterview(app, ctx);

    const pending = await getReport(ctx);
    expect(pending.status).toBe(202);
    expect(pending.body).toEqual({ status: 'generating' });

    expect(await runReportJobs()).toEqual(['succeeded']);

    const res = await getReport(ctx);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ready');
    const { report } = res.body;
    expect(report.overall).toEqual(expect.any(Number));
    expect(report.questionsAnswered).toBeGreaterThan(10);
    expect(Object.keys(report.dimensionScores)).toEqual(
      expect.arrayContaining(['technical_knowledge', 'communication']),
    );
    expect(report.strengths.length).toBeGreaterThan(0);
    expect(report.feedback).toEqual(expect.any(String));
    expect(report.recommendations[0]).toMatchObject({
      topic: expect.any(String),
      reason: expect.any(String),
      resources: expect.arrayContaining([{ title: expect.any(String), url: null }]),
    });
    expect((await InterviewModel.findById(ctx.id).lean())?.reportStatus).toBe('ready');

    const progress = await request(app).get('/api/v1/users/me/progress').set(ctx.auth);
    expect(progress.body.overall).toHaveLength(1);
    expect(progress.body.overall[0].score).toBe(report.overall);
    expect(progress.body.dimensions.map((d: { dimension: string }) => d.dimension)).toContain(
      'technical_knowledge',
    );
    expect(progress.body.skills.map((s: { skill: string }) => s.skill)).toContain('redis');
  });

  it('feeds the next interview plan from the skill scores', async () => {
    const ctx = await startedInterview(app);
    await completeInterview(app, ctx);
    await runReportJobs();
    const scores = await SkillHistoryModel.find({ userId: ctx.userId }).lean();
    expect(scores.length).toBeGreaterThan(0);

    const next = await request(app).post('/api/v1/interviews').set(ctx.auth).send({ mode: 'text' });
    expect(next.status).toBe(201);
  });

  it('is idempotent: running the job again creates no duplicates', async () => {
    const ctx = await startedInterview(app);
    await completeInterview(app, ctx);
    await runReportJobs();
    const skillRows = await SkillHistoryModel.countDocuments({ interviewId: ctx.id });

    await jobQueue.enqueue('report.generate', { interviewId: ctx.id });
    expect(await runReportJobs()).toEqual(['succeeded']);
    expect(await ReportModel.countDocuments({ interviewId: ctx.id })).toBe(1);
    expect(await SkillHistoryModel.countDocuments({ interviewId: ctx.id })).toBe(skillRows);
  });

  it('reports insufficient answers when ended too early', async () => {
    const ctx = await startedInterview(app);
    await answer(app, ctx, 1);
    await request(app).post(`/api/v1/interviews/${ctx.id}/end`).set(ctx.auth);
    expect(await runReportJobs()).toEqual(['succeeded']);

    const res = await getReport(ctx);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'insufficient_answers',
      message: 'Answer at least 2 questions to get a report.',
    });
  });

  it('marks the report failed when the AI refuses, without retrying', async () => {
    const ctx = await startedInterview(app);
    await completeInterview(app, ctx);
    const mock = new MockProvider();
    setAiGateway({
      provider: 'refusing',
      analyzeResume: (t, c) => mock.analyzeResume(t, c),
      generateQuestion: (r, c) => mock.generateQuestion(r, c),
      evaluateAnswer: (r, c) => mock.evaluateAnswer(r, c),
      generateReport: () => Promise.reject(new AiError('declined', false)),
    });

    expect(await runReportJobs()).toEqual(['dead']);
    const res = await getReport(ctx);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.message).toMatch(/could not generate/);
  });

  it('retries transient AI failures and keeps generating meanwhile', async () => {
    const ctx = await startedInterview(app);
    await completeInterview(app, ctx);
    const mock = new MockProvider();
    let failures = 1;
    setAiGateway({
      provider: 'flaky',
      analyzeResume: (t, c) => mock.analyzeResume(t, c),
      generateQuestion: (r, c) => mock.generateQuestion(r, c),
      evaluateAnswer: (r, c) => mock.evaluateAnswer(r, c),
      generateReport: (r, c) =>
        failures-- > 0 ? Promise.reject(new Error('timeout')) : mock.generateReport(r, c),
    });

    expect(await runReportJobs()).toEqual(['retry']);
    expect((await getReport(ctx)).status).toBe(202);

    await JobModel.updateMany({ status: 'queued' }, { $set: { runAt: new Date() } });
    expect(await runReportJobs()).toEqual(['succeeded']);
    expect((await getReport(ctx)).body.status).toBe('ready');
  });

  it('queues a report once for interviews that ended before reports existed', async () => {
    const ctx = await startedInterview(app);
    await completeInterview(app, ctx);
    await JobModel.deleteMany({});
    await InterviewModel.updateOne({ _id: ctx.id }, { $unset: { reportStatus: 1 } });

    expect((await getReport(ctx)).status).toBe(202);
    expect((await getReport(ctx)).status).toBe(202);
    expect(await JobModel.countDocuments({ 'payload.interviewId': ctx.id })).toBe(1);

    await runReportJobs();
    expect((await getReport(ctx)).body.status).toBe('ready');
  });

  it('returns 409 for an interview that has not ended', async () => {
    const ctx = await createdInterview(app);
    expect((await getReport(ctx)).status).toBe(409);
  });
});

import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { setAiGateway } from '../../src/modules/ai/gateway.js';
import { MockProvider } from '../../src/modules/ai/providers/mock.js';
import { isRepeatQuestion } from '../../src/modules/interviews/engine/question-repeat.js';
import { InterviewModel, InterviewTurnModel } from '../../src/modules/interviews/model.js';
import { JobModel } from '../../src/modules/jobs/model.js';
import { useTestDb } from '../helpers/db.js';
import {
  ANSWER,
  answer as answerFor,
  createdInterview as createdInterviewFor,
  startedInterview,
  type InterviewCtx,
} from '../helpers/interviews.js';

useTestDb();
const app = createApp();

const createdInterview = () => createdInterviewFor(app);
const started = () => startedInterview(app);
const answer = (ctx: InterviewCtx, seq: number, answerText = ANSWER) =>
  answerFor(app, ctx, seq, answerText);

afterEach(() => setAiGateway(new MockProvider()));

describe('POST /interviews/:id/start', () => {
  it('starts the interview and returns the first question in the response', async () => {
    const { start } = await started();
    expect(start.status).toBe(200);
    expect(start.body.interview).toMatchObject({ status: 'in_progress' });
    expect(start.body.interview.startedAt).toEqual(expect.any(String));
    expect(start.body.currentTurn).toMatchObject({
      seq: 1,
      objectiveIdx: 0,
      objectiveKind: 'warmup',
      isFollowUp: false,
    });
    expect(start.body.currentTurn.questionText).toContain('Payment Gateway');
    expect(start.body.progress).toMatchObject({
      objectiveIdx: 0,
      objectiveCount: 6,
      objectiveKind: 'warmup',
      questionsAsked: 1,
      remainingSec: expect.any(Number),
    });
  });

  it('is idempotent: calling it again returns the same open question', async () => {
    const ctx = await started();
    const again = await request(app).post(`/api/v1/interviews/${ctx.id}/start`).set(ctx.auth);
    expect(again.status).toBe(200);
    expect(again.body.currentTurn).toEqual(ctx.start.body.currentTurn);
    expect(await InterviewTurnModel.countDocuments({ interviewId: ctx.id })).toBe(1);
  });

  it('handles concurrent starts without creating two first questions', async () => {
    const ctx = await createdInterview();
    const [a, b] = await Promise.all([
      request(app).post(`/api/v1/interviews/${ctx.id}/start`).set(ctx.auth),
      request(app).post(`/api/v1/interviews/${ctx.id}/start`).set(ctx.auth),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body.currentTurn.seq).toBe(1);
    expect(await InterviewTurnModel.countDocuments({ interviewId: ctx.id })).toBe(1);
  });

  it('GET /interviews/:id exposes progress and currentTurn next to interview', async () => {
    const created = await createdInterview();
    const before = await request(app).get(`/api/v1/interviews/${created.id}`).set(created.auth);
    expect(before.body).toMatchObject({ progress: null, currentTurn: null });
    expect(before.body.interview.status).toBe('created');

    const ctx = await started();
    const after = await request(app).get(`/api/v1/interviews/${ctx.id}`).set(ctx.auth);
    expect(after.body.currentTurn).toEqual(ctx.start.body.currentTurn);
    expect(after.body.progress.questionsAsked).toBe(1);
  });
});

describe('POST /interviews/:id/answers', () => {
  it('rejects answers before start', async () => {
    const ctx = await createdInterview();
    const res = await answer(ctx, 1);
    expect(res.status).toBe(409);
  });

  it('scores the answer and returns the next question, hiding scores mid-interview', async () => {
    const ctx = await started();
    const res = await answer(ctx, 1);
    expect(res.status).toBe(200);
    expect(res.body.closingMessage).toBeNull();
    expect(res.body.currentTurn).toMatchObject({ seq: 2, isFollowUp: true });
    expect(res.body.progress.questionsAsked).toBe(2);

    const stored = await InterviewTurnModel.findOne({ interviewId: ctx.id, seq: 1 }).lean();
    expect(stored?.answerText).toBe(ANSWER);
    expect(stored?.evaluation?.overall).toEqual(expect.any(Number));
    expect(stored?.decision?.move).toEqual(expect.any(String));

    const turns = await request(app).get(`/api/v1/interviews/${ctx.id}/turns`).set(ctx.auth);
    expect(turns.body.items).toHaveLength(2);
    expect(turns.body.items[0]).toMatchObject({
      answerText: ANSWER,
      evaluation: null,
      decision: null,
    });
  });

  it('challenges a vague answer with a follow-up quoting it', async () => {
    const ctx = await started();
    const res = await answer(ctx, 1, 'We optimised the queries.');
    expect(res.body.currentTurn.questionText).toContain('We optimised the queries.');
  });

  it('treats a duplicate submit as a replay, not a new answer', async () => {
    const ctx = await started();
    const first = await answer(ctx, 1);
    const duplicate = await answer(ctx, 1);
    expect(duplicate.status).toBe(200);
    expect(duplicate.body.currentTurn).toEqual(first.body.currentTurn);
    expect(await InterviewTurnModel.countDocuments({ interviewId: ctx.id })).toBe(2);
  });

  it('rejects a stale or future seq with the current seq in details', async () => {
    const ctx = await started();
    await answer(ctx, 1);
    const stale = await answer(ctx, 1, 'a different answer from another tab');
    expect(stale.status).toBe(409);
    expect(stale.body.error.details).toEqual({ currentSeq: 2 });
    expect((await answer(ctx, 5)).status).toBe(409);
  });

  it('validates the body', async () => {
    const ctx = await started();
    expect((await answer(ctx, 1, '   ')).status).toBe(400);
    expect((await answer(ctx, 1, 'x'.repeat(5001))).status).toBe(400);
    const missingSeq = await request(app)
      .post(`/api/v1/interviews/${ctx.id}/answers`)
      .set(ctx.auth)
      .send({ answerText: ANSWER });
    expect(missingSeq.status).toBe(400);
  });

  it('returns 503 when the AI fails and processes the answer on retry', async () => {
    const ctx = await started();
    const mock = new MockProvider();
    let failures = 1;
    setAiGateway({
      provider: 'flaky',
      analyzeResume: (t, c) => mock.analyzeResume(t, c),
      generateQuestion: (r, c) => mock.generateQuestion(r, c),
      generateReport: (r, c) => mock.generateReport(r, c),
      evaluateAnswer: (r, c) => {
        if (failures-- > 0) return Promise.reject(new Error('provider timeout'));
        return mock.evaluateAnswer(r, c);
      },
    });

    const failed = await answer(ctx, 1);
    expect(failed.status).toBe(503);
    expect(failed.body.error.code).toBe('SERVICE_UNAVAILABLE');

    const retried = await answer(ctx, 1);
    expect(retried.status).toBe(200);
    expect(retried.body.currentTurn.seq).toBe(2);
  });

  it('moves to the next topic when the interviewer keeps repeating itself', async () => {
    const ctx = await started();
    const mock = new MockProvider();
    const stuck = 'Walk me through the Payment Gateway architecture.';
    let calls = 0;
    setAiGateway({
      provider: 'repetitive',
      analyzeResume: (t, c) => mock.analyzeResume(t, c),
      evaluateAnswer: (r, c) => mock.evaluateAnswer(r, c),
      generateReport: (r, c) => mock.generateReport(r, c),
      generateQuestion: async (r) => {
        calls++;
        // Stuck on one question for the thread; a new objective gets a fresh one.
        const question = r.move === 'next_objective' ? `New topic: ${r.objective.topic}?` : stuck;
        return { question, expectedConcepts: [], goodAnswer: '' };
      },
    });
    await InterviewTurnModel.updateOne(
      { interviewId: ctx.id, seq: 1 },
      { $set: { questionText: stuck } },
    );

    const res = await answer(ctx, 1);
    expect(res.status).toBe(200);
    expect(res.body.currentTurn).toMatchObject({ seq: 2, objectiveIdx: 1, isFollowUp: false });
    expect(res.body.currentTurn.questionText).not.toBe(stuck);
    expect(calls).toBe(3); // first try, one retry, then the next objective's question
    const decided = await InterviewTurnModel.findOne({ interviewId: ctx.id, seq: 1 }).lean();
    expect(decided?.decision?.move).toBe('next_objective');
  });

  it('runs a whole interview to the end, then queues the report and reveals scores', async () => {
    const ctx = await started();
    let current = ctx.start.body.currentTurn;
    let last;
    for (let i = 0; i < 40 && current; i++) {
      last = await answer(ctx, current.seq);
      expect(last.status).toBe(200);
      current = last.body.currentTurn;
    }

    expect(current).toBeNull();
    expect(last!.body.interview.status).toBe('ended');
    expect(last!.body.closingMessage).toMatch(/report will be ready/);
    expect(last!.body.progress.objectiveIdx).toBe(5);

    const doc = await InterviewModel.findById(ctx.id).lean();
    expect(doc?.endReason).toBe('completed');
    expect(
      await JobModel.countDocuments({ type: 'report.generate', 'payload.interviewId': ctx.id }),
    ).toBe(1);

    const turns = await request(app)
      .get(`/api/v1/interviews/${ctx.id}/turns?limit=100`)
      .set(ctx.auth);
    const kinds = new Set(turns.body.items.map((t: { objectiveKind: string }) => t.objectiveKind));
    const questions: string[] = turns.body.items.map(
      (t: { questionText: string }) => t.questionText,
    );
    questions.forEach((q, i) => expect(isRepeatQuestion(q, questions.slice(0, i))).toBe(false));
    expect(kinds.size).toBe(6); // every objective in the plan was covered
    expect(turns.body.items[0].evaluation.overall).toEqual(expect.any(Number));

    // The frontend's "go to report" calls /end after the closing message: it must be a no-op.
    const end = await request(app).post(`/api/v1/interviews/${ctx.id}/end`).set(ctx.auth);
    expect(end.status).toBe(200);
    expect(end.body.interview.status).toBe('ended');
    expect((await InterviewModel.findById(ctx.id).lean())?.endReason).toBe('completed');
    expect(
      await JobModel.countDocuments({ type: 'report.generate', 'payload.interviewId': ctx.id }),
    ).toBe(1);

    // The final answer replayed after the end is still a replay, a new one is rejected.
    const lastSeq = turns.body.items.at(-1).seq;
    expect((await answer(ctx, lastSeq)).status).toBe(200);
    expect((await answer(ctx, lastSeq, 'something new')).status).toBe(409);
  });

  it('ends the interview when the time is up', async () => {
    const ctx = await started();
    await InterviewModel.updateOne(
      { _id: ctx.id },
      { $set: { startedAt: new Date(Date.now() - 16 * 60 * 1000) } },
    );
    const res = await answer(ctx, 1);
    expect(res.status).toBe(200);
    expect(res.body.currentTurn).toBeNull();
    expect(res.body.interview.status).toBe('ended');
    expect(res.body.closingMessage).toMatch(/out of time/);
    expect(res.body.progress.remainingSec).toBe(0);
    expect((await InterviewModel.findById(ctx.id).lean())?.endReason).toBe('timeout');
  });

  it('rejects answers after the user ended the interview', async () => {
    const ctx = await started();
    await request(app).post(`/api/v1/interviews/${ctx.id}/end`).set(ctx.auth);
    expect((await answer(ctx, 1)).status).toBe(409);
    const restart = await request(app).post(`/api/v1/interviews/${ctx.id}/start`).set(ctx.auth);
    expect(restart.status).toBe(409);
  });
});

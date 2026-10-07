import { describe, expect, it } from 'vitest';
import { hitRateLimit } from '../../src/common/middleware/rate-limit.js';
import { JobModel } from '../../src/modules/jobs/model.js';
import { jobQueue, NonRetryableError } from '../../src/modules/jobs/queue.js';
import { useTestDb } from '../helpers/db.js';

useTestDb();

describe('MongoDB job queue', () => {
  it('lets exactly one of many concurrent workers claim a job', async () => {
    const job = await jobQueue.enqueue('report.generate', { interviewId: 'a' });
    const claims = await Promise.all(
      Array.from({ length: 8 }, (_, i) => jobQueue.claim(`w${i}`, ['report.generate'], 60_000)),
    );
    const winners = claims.filter((c) => c?._id.equals(job._id));
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ status: 'running', attempts: 1 });
  });

  it('does not claim jobs scheduled in the future or of other types', async () => {
    await jobQueue.enqueue(
      'resume.parse',
      { resumeId: 'later' },
      { runAt: new Date(Date.now() + 60_000) },
    );
    expect(await jobQueue.claim('w', ['resume.parse'], 60_000)).toBeNull();
    expect(await jobQueue.claim('w', ['nonexistent.type'], 60_000)).toBeNull();
  });

  it('requeues failures with backoff, then dead-letters after maxAttempts', async () => {
    const job = await jobQueue.enqueue('resume.parse', { resumeId: 'r1' }, { maxAttempts: 2 });

    let claimed = (await jobQueue.claim('w', ['resume.parse'], 60_000))!;
    expect(await jobQueue.fail(claimed, 'w', new Error('boom'))).toBe('retry');
    const requeued = await JobModel.findById(job._id).lean();
    expect(requeued).toMatchObject({ status: 'queued', lastError: 'boom' });
    expect(requeued!.runAt.getTime()).toBeGreaterThan(Date.now());

    await JobModel.updateOne({ _id: job._id }, { $set: { runAt: new Date() } });
    claimed = (await jobQueue.claim('w', ['resume.parse'], 60_000))!;
    expect(await jobQueue.fail(claimed, 'w', new Error('boom again'))).toBe('dead');
    expect((await JobModel.findById(job._id).lean())?.status).toBe('dead');
  });

  it('dead-letters non-retryable errors immediately', async () => {
    await JobModel.deleteMany({});
    await jobQueue.enqueue('resume.parse', { resumeId: 'r2' });
    const claimed = (await jobQueue.claim('w', ['resume.parse'], 60_000))!;
    expect(await jobQueue.fail(claimed, 'w', new NonRetryableError('bad input'))).toBe('dead');
  });

  it('reclaims a job whose worker died (lock expired)', async () => {
    await JobModel.deleteMany({});
    const job = await jobQueue.enqueue('resume.parse', { resumeId: 'r3' });
    await jobQueue.claim('crashed-worker', ['resume.parse'], 1);
    await new Promise((r) => setTimeout(r, 10));

    const reclaimed = await jobQueue.claim('healthy-worker', ['resume.parse'], 60_000);
    expect(reclaimed?._id.equals(job._id)).toBe(true);
    expect(reclaimed).toMatchObject({ lockedBy: 'healthy-worker', attempts: 2 });

    // The crashed worker can no longer complete it.
    await jobQueue.complete(job._id, 'crashed-worker');
    expect((await JobModel.findById(job._id).lean())?.status).toBe('running');
  });
});

describe('MongoDB rate limiter', () => {
  it('counts hits per fixed window, including concurrent first hits', async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => hitRateLimit('test:ip:1', 60_000)),
    );
    expect(results.map((r) => r.count).sort()).toEqual([1, 2, 3, 4, 5]);
    expect((await hitRateLimit('test:ip:2', 60_000)).count).toBe(1);
  });
});

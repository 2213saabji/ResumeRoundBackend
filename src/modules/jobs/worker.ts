import { setTimeout as sleep } from 'node:timers/promises';
import type { Logger } from '../../common/logger.js';
import { JobModel, type Job, type JobPayloads, type JobType } from './model.js';
import { jobQueue } from './queue.js';

export interface JobContext {
  job: Job;
  log: Logger;
  /** True on the last attempt; handlers use it to mark their own documents as failed. */
  isFinalAttempt: boolean;
}

export type JobHandler<T extends JobType> = (
  payload: JobPayloads[T],
  ctx: JobContext,
) => Promise<void>;
export type JobHandlers = { [K in JobType]?: JobHandler<K> };

interface WorkerOptions {
  workerId: string;
  handlers: JobHandlers;
  log: Logger;
  concurrency: number;
  pollMinMs: number;
  pollMaxMs: number;
  lockMs?: number;
}

export interface RunningWorker {
  stop(): Promise<void>;
}

/**
 * Polls the jobs collection with exponential idle backoff, and wakes immediately on inserts
 * via a change stream when the deployment supports it (Atlas does). Running jobs renew their
 * lock periodically, so a crashed worker's jobs are reclaimed once the lock lapses.
 */
export function startWorker(opts: WorkerOptions): RunningWorker {
  const lockMs = opts.lockMs ?? 5 * 60 * 1000;
  const types = Object.keys(opts.handlers);
  const active = new Set<Promise<void>>();
  const abort = new AbortController();
  let wake: AbortController | undefined;

  const changeStream = startChangeStream(opts.log, () => wake?.abort());

  async function runJob(job: Job): Promise<void> {
    const log = opts.log.child({
      jobId: job._id.toString(),
      jobType: job.type,
      attempt: job.attempts,
    });
    const handler = opts.handlers[job.type as JobType] as JobHandler<JobType> | undefined;
    const heartbeat = setInterval(() => {
      jobQueue
        .extendLock(job._id, opts.workerId, lockMs)
        .catch((err: unknown) => log.warn({ err }, 'lock renewal failed'));
    }, lockMs / 3);

    try {
      if (!handler) throw new Error(`No handler registered for ${job.type}`);
      if (job.attempts > job.maxAttempts)
        throw new Error('attempts exhausted (worker crashed mid-job)');
      const started = Date.now();
      await handler(job.payload as JobPayloads[JobType], {
        job,
        log,
        isFinalAttempt: job.attempts >= job.maxAttempts,
      });
      await jobQueue.complete(job._id, opts.workerId);
      log.info({ durationMs: Date.now() - started }, 'job succeeded');
    } catch (err) {
      const outcome = await jobQueue.fail(job, opts.workerId, err);
      log[outcome === 'dead' ? 'error' : 'warn']({ err, outcome }, 'job failed');
    } finally {
      clearInterval(heartbeat);
    }
  }

  async function loop(): Promise<void> {
    let idleDelay = opts.pollMinMs;
    while (!abort.signal.aborted) {
      try {
        if (active.size >= opts.concurrency) {
          await Promise.race(active);
          continue;
        }
        const job = await jobQueue.claim(opts.workerId, types, lockMs);
        if (job) {
          idleDelay = opts.pollMinMs;
          const p = runJob(job).finally(() => active.delete(p));
          active.add(p);
          continue;
        }
        wake = new AbortController();
        await sleep(idleDelay, undefined, {
          signal: AbortSignal.any([abort.signal, wake.signal]),
        }).catch(() => {});
        idleDelay = Math.min(idleDelay * 2, opts.pollMaxMs);
      } catch (err) {
        opts.log.error({ err }, 'worker loop error');
        await sleep(opts.pollMaxMs, undefined, { signal: abort.signal }).catch(() => {});
      }
    }
  }

  opts.log.info(
    { workerId: opts.workerId, types, concurrency: opts.concurrency },
    'job worker started',
  );
  const loopDone = loop();

  return {
    async stop() {
      abort.abort();
      await changeStream?.close().catch(() => {});
      await loopDone;
      await Promise.allSettled(active);
    },
  };
}

function startChangeStream(log: Logger, onInsert: () => void) {
  try {
    const stream = JobModel.watch([{ $match: { operationType: 'insert' } }]);
    stream.on('change', onInsert);
    stream.on('error', (err) => log.debug({ err }, 'jobs change stream unavailable, polling only'));
    return stream;
  } catch (err) {
    log.debug({ err }, 'jobs change stream unavailable, polling only');
    return undefined;
  }
}

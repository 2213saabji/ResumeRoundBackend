import { config } from '../common/config.js';
import { connectDb, disconnectDb } from '../common/db.js';
import { logger } from '../common/logger.js';
import { onShutdown } from '../common/shutdown.js';
import { startWorker } from '../modules/jobs/worker.js';
import { generateReportJob } from '../modules/reports/service.js';
import { parseResumeJob } from '../modules/resumes/jobs.js';

await connectDb(config.MONGODB_URI);

const worker = startWorker({
  workerId: config.WORKER_ID,
  log: logger.child({ app: 'worker' }),
  concurrency: config.JOB_CONCURRENCY,
  pollMinMs: config.JOB_POLL_MIN_MS,
  pollMaxMs: config.JOB_POLL_MAX_MS,
  handlers: {
    'resume.parse': parseResumeJob,
    'report.generate': generateReportJob,
  },
});

onShutdown(async () => {
  await worker.stop();
  await disconnectDb();
}, 60_000);

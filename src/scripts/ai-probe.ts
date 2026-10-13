/**
 * Runs the four interviewer AI tasks against the Ollama server in .env (OLLAMA_URL, OLLAMA_MODEL,
 * per-tier overrides), whatever AI_PROVIDER says, so you can judge a model's quality and speed
 * before switching to it. No database needed; nothing is written to ai_usage.
 *
 *   npx tsx src/scripts/ai-probe.ts
 *   npx tsx src/scripts/ai-probe.ts --model=qwen2.5:7b     # one model for every task
 *
 * Steps: read a sample resume -> ask the opening question -> score a sample answer -> write a
 * report from that one turn. Each step prints its time and output.
 */
import { config } from '../common/config.js';
import { OllamaProvider } from '../modules/ai/providers/ollama.js';
import type { InterviewAiContext } from '../modules/ai/types.js';
import type { PlanObjective } from '../modules/interviews/engine/types.js';

const out = (line: string) => process.stdout.write(`${line}\n`);
const modelFlag = process.argv.find((a) => a.startsWith('--model='))?.slice('--model='.length);

const RESUME = `Asha Rao - Backend Engineer - asha@example.com
Experience: 4 years
PayFlow (fintech), Software Engineer II, 2023-present
- Built the Payment Gateway in Node.js and TypeScript handling 2,000 RPS at peak.
- Moved order events to Kafka; added idempotency keys so retried payments are never charged twice.
- Cut p99 latency from 800 ms to 120 ms with Redis caching of merchant config.
ShopKart (e-commerce), Software Engineer, 2021-2023
- Maintained the catalogue service (Java, Spring Boot, PostgreSQL), 2M products.
- Wrote the nightly price-sync job; moved it from cron to AWS SQS workers.
Skills: TypeScript, Node.js, Java, Spring Boot, PostgreSQL, Redis, Kafka, AWS (SQS, ECS), Docker`;

const ANSWER =
  'The gateway is a Node.js service in front of three payment providers. Each request carries an ' +
  'idempotency key that we store in Redis with the result, so a retry returns the stored result ' +
  'instead of charging again. I owned the retry and idempotency layer and the Kafka events.';

const model = (tier: string | undefined) => modelFlag ?? tier ?? config.OLLAMA_MODEL;
const models = {
  small: model(config.OLLAMA_MODEL_SMALL),
  mid: model(config.OLLAMA_MODEL_MID),
  large: model(config.OLLAMA_MODEL_LARGE),
};
const ai = new OllamaProvider({
  baseUrl: config.OLLAMA_URL,
  apiKey: config.OLLAMA_API_KEY,
  models,
  numCtx: config.OLLAMA_NUM_CTX,
  // Laptop GPUs (especially on battery) are slow; this script waits longer than the app does.
  timeoutMs: Math.max(config.OLLAMA_TIMEOUT_MS, 600_000),
  meter: false,
});

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = performance.now();
  const result = await run();
  out(`\n=== ${name} (${((performance.now() - started) / 1000).toFixed(1)} s) ===`);
  out(JSON.stringify(result, null, 2));
  return result;
}

try {
  out(`Ollama ${config.OLLAMA_URL}, models ${JSON.stringify(models)}`);

  const resume = await step('1. Resume analysis (mid model)', () => ai.analyzeResume(RESUME, {}));
  const context: InterviewAiContext = {
    role: 'backend',
    level: 'sde2',
    companyType: 'product',
    candidate: {
      experienceYears: resume.experienceYears,
      seniority: resume.seniority,
      domain: resume.domain,
      skills: resume.skills,
      projects: resume.projects,
    },
  };
  const project = resume.projects[0];
  const objective: PlanObjective = {
    kind: 'project_deep_dive',
    topic: `Architecture of ${project?.name ?? 'the main project'}`,
    technologies: project?.technologies ?? [],
    projectName: project?.name ?? null,
    startDifficulty: 5,
    timeBudgetSec: 300,
    isCoreDeepDive: true,
  };

  const question = await step('2. Opening question (small model, every turn)', () =>
    ai.generateQuestion(
      {
        context,
        objective,
        move: 'opening',
        difficulty: 5,
        recentTurns: [],
        coveredConcepts: [],
        focusConcept: null,
        vagueClaim: null,
        askedQuestions: [],
      },
      {},
    ),
  );

  const evaluation = await step('3. Answer scoring (mid model, every turn)', () =>
    ai.evaluateAnswer(
      {
        context,
        objective,
        difficulty: 5,
        question: question.question,
        expectedConcepts: question.expectedConcepts,
        goodAnswer: question.goodAnswer,
        answer: ANSWER,
        recentTurns: [],
      },
      {},
    ),
  );

  await step('4. Report (large model, once per interview)', () =>
    ai.generateReport(
      {
        context,
        endReason: 'plan_complete',
        dimensionScores: { technical_knowledge: evaluation.overall },
        overall: evaluation.overall,
        turns: [
          {
            objectiveKind: objective.kind,
            topic: objective.topic,
            question: question.question,
            answer: ANSWER,
            overall: evaluation.overall,
            missedConcepts: evaluation.missedConcepts,
            evidence: evaluation.evidence,
          },
        ],
      },
      {},
    ),
  );
} catch (err) {
  out(`\nfailed: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}

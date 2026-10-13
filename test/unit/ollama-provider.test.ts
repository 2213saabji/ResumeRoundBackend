import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OllamaProvider } from '../../src/modules/ai/providers/ollama.js';
import { AiError, type QuestionRequest } from '../../src/modules/ai/types.js';

const recordUsage = vi.hoisted(() => vi.fn());
vi.mock('../../src/modules/ai/cost-meter.js', () => ({ recordUsage }));

const request: QuestionRequest = {
  context: {
    role: 'backend',
    level: 'sde2',
    companyType: 'product',
    candidate: { experienceYears: 4, seniority: 'sde2', domain: null, skills: {}, projects: [] },
  },
  objective: {
    kind: 'project_deep_dive',
    topic: 'Architecture of Payment Gateway',
    technologies: ['Node.js', 'Redis'],
    projectName: 'Payment Gateway',
    startDifficulty: 5,
    timeBudgetSec: 300,
    isCoreDeepDive: true,
  },
  move: 'opening',
  difficulty: 5,
  recentTurns: [],
  coveredConcepts: [],
  focusConcept: null,
  vagueClaim: null,
  askedQuestions: [],
};

const spec = {
  question: '  Walk me through the Payment Gateway. What did you own? ',
  expectedConcepts: ['idempotency', 'retries', 'idempotency'],
  goodAnswer: 'Explains the flow and their part in it.',
};

const reply = (content: string, extra: Record<string, unknown> = {}) =>
  Response.json({
    model: 'qwen2.5:3b',
    message: { role: 'assistant', content },
    done_reason: 'stop',
    prompt_eval_count: 900,
    eval_count: 60,
    ...extra,
  });

function provider(apiKey?: string) {
  return new OllamaProvider({
    baseUrl: 'http://gpu.internal:11434/',
    apiKey,
    models: { small: 'qwen2.5:3b', mid: 'qwen2.5:7b', large: 'qwen2.5:14b' },
    numCtx: 16_384,
    timeoutMs: 5_000,
  });
}

function stubFetch(...responses: Response[]) {
  const fetchMock = vi.fn(async () => responses.shift()!);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('OllamaProvider', () => {
  beforeEach(() => recordUsage.mockClear());
  afterEach(() => vi.unstubAllGlobals());

  it('asks the small model for schema-shaped JSON with a fixed context window', async () => {
    const fetchMock = stubFetch(reply(JSON.stringify(spec)));
    const out = await provider().generateQuestion(request, { interviewId: 'i1' });

    expect(out).toEqual({
      question: 'Walk me through the Payment Gateway. What did you own?',
      expectedConcepts: ['idempotency', 'retries'],
      goodAnswer: 'Explains the flow and their part in it.',
    });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://gpu.internal:11434/api/chat');
    expect((init.headers as Record<string, string>).authorization).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body).toMatchObject({
      model: 'qwen2.5:3b',
      stream: false,
      options: { num_ctx: 16_384, num_predict: 1_000 },
    });
    expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['system', 'user']);
    expect(body.format).toMatchObject({
      type: 'object',
      required: expect.arrayContaining(['question', 'expectedConcepts', 'goodAnswer']),
    });
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'ollama',
        model: 'qwen2.5:3b',
        inputTokens: 900,
        outputTokens: 60,
        costUsd: 0,
        interviewId: 'i1',
      }),
    );
  });

  it('sends the API key when one is set (Ollama Cloud)', async () => {
    const fetchMock = stubFetch(reply(JSON.stringify(spec)));
    await provider('cloud-key').generateQuestion(request, {});
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer cloud-key');
  });

  it('retries once after invalid output', async () => {
    const fetchMock = stubFetch(reply('{"question": "unfinished'), reply(JSON.stringify(spec)));
    const out = await provider().generateQuestion(request, {});
    expect(out.question).toContain('Payment Gateway');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('gives up with a retryable error after two bad replies', async () => {
    stubFetch(
      reply(JSON.stringify({ question: 'missing fields' })),
      reply('', { done_reason: 'length' }),
    );
    const err = await provider()
      .generateQuestion(request, {})
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).retryable).toBe(true);
    expect((err as AiError).message).toContain('cut off');
  });

  it('explains how to fix a missing model', async () => {
    stubFetch(new Response('{"error":"model not found"}', { status: 404 }));
    const err = (await provider()
      .generateQuestion(request, {})
      .catch((e: unknown) => e)) as AiError;
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('ollama pull qwen2.5:3b');
  });

  it('reports an unreachable server as retryable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const err = (await provider()
      .generateQuestion(request, {})
      .catch((e: unknown) => e)) as AiError;
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('unreachable');
  });
});

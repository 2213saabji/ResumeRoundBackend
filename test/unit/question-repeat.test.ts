import { describe, expect, it } from 'vitest';
import { MockProvider } from '../../src/modules/ai/providers/mock.js';
import type { QuestionRequest } from '../../src/modules/ai/types.js';
import {
  isRepeatQuestion,
  questionSimilarity,
} from '../../src/modules/interviews/engine/question-repeat.js';

const Q =
  'Now suppose traffic grows 10x. What breaks first in that design, and how would you handle it?';

describe('isRepeatQuestion', () => {
  it('catches exact repeats regardless of case and punctuation', () => {
    expect(isRepeatQuestion(Q.toUpperCase().replace(/[?.,]/g, ''), [Q])).toBe(true);
  });

  it('catches near-verbatim rewordings', () => {
    const reworded =
      'Now suppose the traffic grows 10x. What breaks first in this design, and how would you handle that?';
    expect(questionSimilarity(Q, reworded)).toBeGreaterThanOrEqual(0.8);
    expect(isRepeatQuestion(reworded, ['Tell me about yourself.', Q])).toBe(true);
  });

  it('does not flag genuinely different follow-ups on the same topic', () => {
    expect(
      isRepeatQuestion(
        'What happens in the Payment Gateway if Redis is unavailable for five minutes at peak load?',
        [Q],
      ),
    ).toBe(false);
    expect(isRepeatQuestion(Q, [])).toBe(false);
  });
});

describe('mock interviewer', () => {
  it('never repeats a question across consecutive identical moves', async () => {
    const mock = new MockProvider();
    const asked: string[] = [];
    for (let i = 0; i < 4; i++) {
      const req: QuestionRequest = {
        context: {
          role: 'backend',
          level: 'sde2',
          companyType: 'product',
          candidate: {
            experienceYears: 4,
            seniority: 'sde2',
            domain: null,
            skills: {},
            projects: [],
          },
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
        move: 'raise_difficulty',
        difficulty: 6,
        recentTurns: [],
        coveredConcepts: [],
        focusConcept: null,
        vagueClaim: null,
        askedQuestions: [...asked],
      };
      const { question } = await mock.generateQuestion(req, {});
      expect(isRepeatQuestion(question, asked)).toBe(false);
      asked.push(question);
    }
  });
});

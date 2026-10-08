import { describe, expect, it } from 'vitest';
import { aggregateScores, type ScoredTurn } from '../../src/modules/reports/aggregate.js';

const turn = (over: Partial<ScoredTurn> = {}): ScoredTurn => ({
  dimensionScores: {},
  overall: 5,
  confidence: 1,
  technologies: [],
  ...over,
});

describe('aggregateScores', () => {
  it('averages each dimension only over answers that scored it', () => {
    const out = aggregateScores([
      turn({ dimensionScores: { system_design: 8, communication: 6 } }),
      turn({ dimensionScores: { system_design: 4 } }),
    ]);
    expect(out.dimensionScores).toEqual({ system_design: 6, communication: 6 });
  });

  it('weights by evaluator confidence, with a floor for low-confidence answers', () => {
    const out = aggregateScores([
      turn({ overall: 9, confidence: 1 }),
      turn({ overall: 1, confidence: 0 }),
    ]);
    // weights 1 and 0.1 -> (9 + 0.1) / 1.1
    expect(out.overall).toBe(8.3);
  });

  it('scores each technology from the answers of objectives that covered it', () => {
    const out = aggregateScores([
      turn({ overall: 8, technologies: ['Redis', 'Kafka'] }),
      turn({ overall: 4, technologies: ['redis'] }),
    ]);
    expect(out.skillScores).toEqual({ Redis: 6, Kafka: 8 });
  });

  it('keeps dimensions in the canonical order and drops unknown keys', () => {
    const out = aggregateScores([
      turn({ dimensionScores: { production_thinking: 5, technical_knowledge: 7, made_up: 3 } }),
    ]);
    expect(Object.keys(out.dimensionScores)).toEqual([
      'technical_knowledge',
      'production_thinking',
    ]);
  });

  it('is deterministic: re-scoring the same transcript gives identical results', () => {
    const turns = [
      turn({ overall: 6.5, confidence: 0.8, dimensionScores: { depth: 7 }, technologies: ['Go'] }),
      turn({ overall: 3, confidence: 0.4, dimensionScores: { depth: 2 }, technologies: ['Go'] }),
    ];
    expect(aggregateScores(turns)).toEqual(aggregateScores(turns));
  });
});

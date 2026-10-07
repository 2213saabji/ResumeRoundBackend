import { describe, expect, it } from 'vitest';
import { computeCostUsd } from '../../src/modules/ai/cost-meter.js';
import { normalizeResumeAnalysis } from '../../src/modules/ai/schemas.js';
import { updateRunningScore, weightedScore } from '../../src/modules/evaluations/scoring.js';
import {
  assertTransition,
  canTransition,
} from '../../src/modules/interviews/engine/state-machine.js';
import { backoffMs } from '../../src/modules/jobs/queue.js';
import { detectResumeFileType } from '../../src/modules/resumes/file-type.js';
import { makePdf } from '../helpers/fixtures.js';

describe('state machine', () => {
  it('allows the normal turn loop', () => {
    const loop = ['created', 'asking', 'listening', 'evaluating', 'deciding', 'asking'] as const;
    for (let i = 1; i < loop.length; i++) expect(canTransition(loop[i - 1]!, loop[i]!)).toBe(true);
    expect(canTransition('deciding', 'closing')).toBe(true);
  });

  it('rejects skipping steps and leaving ended', () => {
    expect(() => assertTransition('asking', 'deciding')).toThrow();
    expect(canTransition('ended', 'asking')).toBe(false);
  });
});

describe('weightedScore', () => {
  const dims = [
    { key: 'architecture', weight: 0.5 },
    { key: 'tradeoffs', weight: 0.25 },
    { key: 'communication', weight: 0.25 },
  ];

  it('weights dimension scores', () => {
    expect(weightedScore({ architecture: 8, tradeoffs: 4, communication: 6 }, dims)).toBe(6.5);
  });

  it('re-normalises when a dimension is missing instead of counting it as 0', () => {
    expect(weightedScore({ architecture: 8 }, dims)).toBe(8);
  });

  it('returns null when nothing was scored and clamps out-of-range scores', () => {
    expect(weightedScore({}, dims)).toBeNull();
    expect(weightedScore({ architecture: 15 }, dims)).toBe(10);
  });

  it('smooths running scores', () => {
    expect(updateRunningScore(undefined, 7)).toBe(7);
    expect(updateRunningScore(5, 10)).toBe(7);
  });
});

describe('computeCostUsd', () => {
  it('prices input, output and cache tokens per million', () => {
    expect(
      computeCostUsd('claude-sonnet-5-5', {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        cacheReadTokens: 1_000_000,
      }),
    ).toBeCloseTo(2 + 1 + 0.2, 6);
  });

  it('records unknown models as 0 rather than throwing', () => {
    expect(computeCostUsd('unknown-model', { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });
});

describe('backoffMs', () => {
  it('grows exponentially and caps at 5 minutes', () => {
    const mid = () => 0.5; // no jitter
    expect(backoffMs(1, mid)).toBe(2000);
    expect(backoffMs(3, mid)).toBe(8000);
    expect(backoffMs(20, mid)).toBe(300_000);
  });
});

describe('detectResumeFileType', () => {
  it('detects PDFs by magic bytes', () => {
    expect(detectResumeFileType(makePdf(['hello']))?.ext).toBe('pdf');
  });

  it('detects DOCX zips by their entries', () => {
    const fakeDocx = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      Buffer.from('....[Content_Types].xml....word/document.xml....'),
    ]);
    expect(detectResumeFileType(fakeDocx)?.ext).toBe('docx');
  });

  it('rejects other content regardless of extension', () => {
    expect(detectResumeFileType(Buffer.from('MZ\x90\x00 not a resume'))).toBeNull();
    expect(
      detectResumeFileType(
        Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('x.jar')]),
      ),
    ).toBeNull();
  });
});

describe('normalizeResumeAnalysis', () => {
  it('dedupes skills case-insensitively and clamps experience', () => {
    const out = normalizeResumeAnalysis({
      experienceYears: 120,
      seniority: 'senior',
      domain: '  ',
      skills: {
        languages: ['Go', 'go', ' TypeScript '],
        frameworks: [],
        databases: [],
        cloud: [],
        architecture: [],
      },
      projects: [],
    });
    expect(out.experienceYears).toBe(50);
    expect(out.domain).toBeNull();
    expect(out.skills.languages).toEqual(['Go', 'TypeScript']);
  });
});

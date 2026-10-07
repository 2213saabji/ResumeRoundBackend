import { describe, expect, it } from 'vitest';
import { LEVEL_DIFFICULTY_BAND } from '../../src/common/domain.js';
import { buildPlan, type PlannerInput } from '../../src/modules/interviews/engine/planner.js';

const profile: PlannerInput['profile'] = {
  skills: {
    languages: ['TypeScript'],
    frameworks: ['Node.js', 'Express'],
    databases: ['PostgreSQL', 'Redis'],
    cloud: ['AWS'],
    architecture: ['microservices'],
  },
  projects: [
    { name: 'Blog', technologies: ['Next.js'], scaleSignals: [] },
    {
      name: 'Payment Gateway',
      technologies: ['Node.js', 'Redis', 'Kafka'],
      scaleSignals: ['2000 RPS'],
    },
  ],
};

const base: PlannerInput = {
  profile,
  role: 'backend',
  level: 'sde2',
  companyType: 'product',
  durationSec: 1800,
  skillScores: {},
};

describe('buildPlan', () => {
  it('starts with a warm-up and a core deep dive on the strongest project', () => {
    const plan = buildPlan(base);
    expect(plan[0]).toMatchObject({ kind: 'warmup', projectName: 'Payment Gateway' });
    expect(plan[1]).toMatchObject({
      kind: 'project_deep_dive',
      isCoreDeepDive: true,
      projectName: 'Payment Gateway',
    });
    expect(plan.filter((o) => o.isCoreDeepDive)).toHaveLength(1);
    expect(plan.at(-1)?.kind).toBe('behavioral');
  });

  it('spends exactly the interview duration (within rounding)', () => {
    const total = buildPlan(base).reduce((sum, o) => sum + o.timeBudgetSec, 0);
    expect(Math.abs(total - 1800)).toBeLessThanOrEqual(3);
  });

  it('keeps every starting difficulty inside the level band', () => {
    for (const level of ['sde1', 'sde2', 'senior', 'staff'] as const) {
      const band = LEVEL_DIFFICULTY_BAND[level];
      for (const o of buildPlan({ ...base, level })) {
        expect(o.startDifficulty).toBeGreaterThanOrEqual(band.min);
        expect(o.startDifficulty).toBeLessThanOrEqual(band.max);
      }
    }
  });

  it('targets the weakest skill from history and skips mastered ones', () => {
    const plan = buildPlan({ ...base, skillScores: { postgresql: 9, redis: 2 } });
    const fundamentals = plan.find((o) => o.kind === 'fundamentals');
    expect(fundamentals?.technologies).toEqual(['Redis']);
  });

  it('gives SDE-1 fundamentals instead of system design', () => {
    const kinds = buildPlan({ ...base, level: 'sde1' }).map((o) => o.kind);
    expect(kinds).not.toContain('system_design');
    expect(kinds).not.toContain('production_debugging');
    expect(kinds.filter((k) => k === 'fundamentals')).toHaveLength(2);
  });

  it('uses a scaling scenario for startups and system design for product companies', () => {
    expect(buildPlan({ ...base, companyType: 'startup' }).map((o) => o.kind)).toContain(
      'scaling_scenario',
    );
    expect(buildPlan(base).map((o) => o.kind)).toContain('system_design');
  });

  it('still produces a usable plan for an empty profile', () => {
    const plan = buildPlan({
      ...base,
      profile: {
        skills: { languages: [], frameworks: [], databases: [], cloud: [], architecture: [] },
        projects: [],
      },
    });
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.every((o) => o.topic.length > 0)).toBe(true);
  });

  it('is deterministic', () => {
    expect(buildPlan(base)).toEqual(buildPlan(base));
  });
});

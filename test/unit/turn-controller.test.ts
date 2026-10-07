import { describe, expect, it } from 'vitest';
import type { PlanObjective } from '../../src/modules/interviews/engine/types.js';
import {
  decide,
  stepDifficulty,
  type ControllerState,
  type DecideInput,
  type TurnEvaluation,
} from '../../src/modules/interviews/engine/turn-controller.js';

const objective = (over: Partial<PlanObjective> = {}): PlanObjective => ({
  kind: 'fundamentals',
  topic: 'PostgreSQL in depth',
  technologies: ['PostgreSQL'],
  projectName: null,
  startDifficulty: 5,
  timeBudgetSec: 300,
  isCoreDeepDive: false,
  ...over,
});

const plan = [
  objective({ isCoreDeepDive: true, kind: 'project_deep_dive' }),
  objective(),
  objective({ startDifficulty: 8 }),
];

const state = (over: Partial<ControllerState> = {}): ControllerState => ({
  currentObjectiveIdx: 1,
  difficulty: 5,
  followUpsOnThread: 0,
  hintsOnThread: 0,
  objectiveStartedAtSec: 0,
  ...over,
});

const evaluation = (over: Partial<TurnEvaluation> = {}): TurnEvaluation => ({
  score: 6,
  confidence: 0.9,
  isVague: false,
  ...over,
});

const input = (over: Partial<DecideInput> = {}): DecideInput => ({
  state: state(),
  plan,
  level: 'sde2',
  elapsedSec: 60,
  totalBudgetSec: 1800,
  evaluation: evaluation(),
  ...over,
});

describe('stepDifficulty', () => {
  it('moves at most 2 per turn', () => {
    expect(stepDifficulty(4, 10, 'senior')).toBe(6);
    expect(stepDifficulty(8, 1, 'senior')).toBe(6);
  });

  it('stays inside the level band', () => {
    expect(stepDifficulty(6, 8, 'sde1')).toBe(6); // sde1 max is 6
    expect(stepDifficulty(7, 5, 'senior')).toBe(6); // senior min is 6
  });
});

describe('decide', () => {
  it('deepens on a solid answer and counts the follow-up', () => {
    const d = decide(input());
    expect(d.move).toBe('deepen');
    expect(d.nextState.followUpsOnThread).toBe(1);
    expect(d.nextState.difficulty).toBe(5);
  });

  it('raises difficulty by at most 2 on a strong answer', () => {
    const d = decide(input({ evaluation: evaluation({ score: 9 }) }));
    expect(d.move).toBe('raise_difficulty');
    expect(d.nextState.difficulty).toBe(7);
  });

  it('challenges a vague answer', () => {
    expect(decide(input({ evaluation: evaluation({ isVague: true }) })).move).toBe(
      'challenge_vague',
    );
  });

  it('asks a clarifying question when evaluator confidence is low', () => {
    expect(decide(input({ evaluation: evaluation({ confidence: 0.3 }) })).move).toBe('clarify');
  });

  it('gives one hint on a weak answer, then moves on', () => {
    const first = decide(input({ evaluation: evaluation({ score: 2 }) }));
    expect(first.move).toBe('hint');
    expect(first.nextState.hintsOnThread).toBe(1);

    const second = decide(input({ state: first.nextState, evaluation: evaluation({ score: 2 }) }));
    expect(second.move).toBe('next_objective');
    expect(second.nextState.currentObjectiveIdx).toBe(2);
  });

  it('moves on after 3 follow-ups on a normal thread', () => {
    const d = decide(input({ state: state({ followUpsOnThread: 3 }) }));
    expect(d.move).toBe('next_objective');
    expect(d.nextState).toMatchObject({
      currentObjectiveIdx: 2,
      followUpsOnThread: 0,
      hintsOnThread: 0,
    });
    // Next objective starts at 8, but the step is capped at +2.
    expect(d.nextState.difficulty).toBe(7);
  });

  it('allows longer threads on the core deep dive', () => {
    const d = decide(input({ state: state({ currentObjectiveIdx: 0, followUpsOnThread: 3 }) }));
    expect(d.move).toBe('deepen');
  });

  it('moves on when the objective time budget is spent', () => {
    const d = decide(input({ elapsedSec: 400, state: state({ objectiveStartedAtSec: 60 }) }));
    expect(d.move).toBe('next_objective');
    expect(d.nextState.objectiveStartedAtSec).toBe(400);
  });

  it('reveals the next scenario stage while the candidate is on track', () => {
    const d = decide(input({ evaluation: evaluation({ scenarioStagesRemaining: 2 }) }));
    expect(d.move).toBe('reveal_scenario_info');
  });

  it('wraps up when the interview time budget is reached', () => {
    expect(decide(input({ elapsedSec: 1800 })).move).toBe('wrap_up');
  });

  it('wraps up after the last objective', () => {
    const d = decide(input({ state: state({ currentObjectiveIdx: 2, followUpsOnThread: 3 }) }));
    expect(d.move).toBe('wrap_up');
  });
});

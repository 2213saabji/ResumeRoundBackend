import { describe, expect, it } from 'vitest';
import type { PlanObjective } from '../../src/modules/interviews/engine/types.js';
import {
  decide,
  moveOn,
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

describe('decide with the evaluator suggestion', () => {
  it('follows the suggested move and difficulty change', () => {
    const d = decide(
      input({
        evaluation: evaluation({
          suggestedMove: 'deepen',
          suggestedDifficultyChange: 1,
          suggestionReason: 'probe cache invalidation',
        }),
      }),
    );
    expect(d.move).toBe('deepen');
    expect(d.nextState.difficulty).toBe(6);
    expect(d.reason).toBe('evaluator: probe cache invalidation');
  });

  it('caps a large suggested difficulty jump at +2 and inside the level band', () => {
    const d = decide(
      input({
        state: state({ difficulty: 7 }),
        evaluation: evaluation({ suggestedMove: 'raise_difficulty', suggestedDifficultyChange: 5 }),
      }),
    );
    expect(d.move).toBe('raise_difficulty');
    expect(d.nextState.difficulty).toBe(8); // sde2 band max is 8
  });

  it('always raises difficulty for raise_difficulty, even with a 0 change', () => {
    const d = decide(
      input({
        evaluation: evaluation({ suggestedMove: 'raise_difficulty', suggestedDifficultyChange: 0 }),
      }),
    );
    expect(d.nextState.difficulty).toBe(6);
  });

  it('turns a suggested wrap_up into moving to the next objective', () => {
    const d = decide(input({ evaluation: evaluation({ suggestedMove: 'wrap_up' }) }));
    expect(d.move).toBe('next_objective');
    expect(d.nextState.currentObjectiveIdx).toBe(2);
  });

  it('allows only one hint per thread, then moves on', () => {
    const d = decide(
      input({
        state: state({ hintsOnThread: 1 }),
        evaluation: evaluation({ suggestedMove: 'hint' }),
      }),
    );
    expect(d.move).toBe('next_objective');
  });

  it('lets hard rules override the suggestion', () => {
    const suggestion = evaluation({ suggestedMove: 'deepen' });
    expect(decide(input({ elapsedSec: 1800, evaluation: suggestion })).move).toBe('wrap_up');
    expect(
      decide(input({ state: state({ followUpsOnThread: 3 }), evaluation: suggestion })).move,
    ).toBe('next_objective');
    expect(
      decide(input({ evaluation: evaluation({ suggestedMove: 'deepen', confidence: 0.2 }) })).move,
    ).toBe('clarify');
  });
});

describe('moveOn', () => {
  it('leaves the thread for the next objective, resetting thread counters', () => {
    const d = moveOn(input({ state: state({ followUpsOnThread: 1, hintsOnThread: 1 }) }), 'repeat');
    expect(d.move).toBe('next_objective');
    expect(d.nextState).toMatchObject({
      currentObjectiveIdx: 2,
      followUpsOnThread: 0,
      hintsOnThread: 0,
    });
  });

  it('wraps up after the last objective or when time is up', () => {
    expect(moveOn(input({ state: state({ currentObjectiveIdx: 2 }) }), 'repeat').move).toBe(
      'wrap_up',
    );
    expect(moveOn(input({ elapsedSec: 1800 }), 'repeat').move).toBe('wrap_up');
  });
});

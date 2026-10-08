export const OBJECTIVE_KINDS = [
  'warmup',
  'project_deep_dive',
  'fundamentals',
  'system_design',
  'scaling_scenario',
  'production_debugging',
  'behavioral',
] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export interface PlanObjective {
  kind: ObjectiveKind;
  topic: string;
  technologies: string[];
  projectName: string | null;
  startDifficulty: number;
  timeBudgetSec: number;
  /** The core deep dive may run longer follow-up threads than other objectives. */
  isCoreDeepDive: boolean;
}

export const MOVES = [
  'deepen',
  'challenge_vague',
  'clarify',
  'raise_difficulty',
  'hint',
  'reveal_scenario_info',
  'next_objective',
  'wrap_up',
] as const;
export type Move = (typeof MOVES)[number];

/** Moves that produce a question: every controller move, plus the interview's first question. */
export const QUESTION_MOVES = ['opening', ...MOVES] as const;

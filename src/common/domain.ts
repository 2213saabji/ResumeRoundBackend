/** Shared domain vocabulary used across modules. */

export const TARGET_ROLES = ['backend', 'frontend', 'fullstack'] as const;
export type TargetRole = (typeof TARGET_ROLES)[number];

export const LEVELS = ['sde1', 'sde2', 'senior', 'staff'] as const;
export type Level = (typeof LEVELS)[number];

export const COMPANY_TYPES = ['startup', 'product', 'faang_style', 'service'] as const;
export type CompanyType = (typeof COMPANY_TYPES)[number];

/** Allowed question difficulty (1-10) per level; the controller never leaves this band. */
export const LEVEL_DIFFICULTY_BAND: Record<Level, { min: number; max: number }> = {
  sde1: { min: 3, max: 6 },
  sde2: { min: 4, max: 8 },
  senior: { min: 6, max: 10 },
  staff: { min: 7, max: 10 },
};

export const SCORE_DIMENSIONS = [
  'technical_knowledge',
  'problem_solving',
  'system_design',
  'communication',
  'depth',
  'production_thinking',
] as const;
export type ScoreDimension = (typeof SCORE_DIMENSIONS)[number];

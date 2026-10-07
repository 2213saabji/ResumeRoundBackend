import {
  LEVEL_DIFFICULTY_BAND,
  type CompanyType,
  type Level,
  type TargetRole,
} from '../../../common/domain.js';
import type { ObjectiveKind, PlanObjective } from './types.js';

export interface PlannerProfile {
  skills: {
    languages: string[];
    frameworks: string[];
    databases: string[];
    cloud: string[];
    architecture: string[];
  };
  projects: { name: string; technologies: string[]; scaleSignals: string[] }[];
}

export interface PlannerInput {
  profile: PlannerProfile;
  role: TargetRole;
  level: Level;
  companyType: CompanyType;
  durationSec: number;
  /** Latest 0-10 score per skill from past interviews (case-insensitive keys). */
  skillScores: Record<string, number>;
}

const DEFAULT_TOPIC: Record<TargetRole, string> = {
  backend: 'API design and data modelling',
  frontend: 'browser rendering and state management',
  fullstack: 'end-to-end web application architecture',
};

/** Unknown skills are treated as mid (5) so they rank between weak and mastered ones. */
const UNKNOWN_SCORE = 5;

function roleRelevantSkills(profile: PlannerProfile, role: TargetRole): string[] {
  const s = profile.skills;
  switch (role) {
    case 'backend':
      return [...s.databases, ...s.architecture, ...s.frameworks, ...s.languages];
    case 'frontend':
      return [...s.frameworks, ...s.languages];
    case 'fullstack':
      return [...s.frameworks, ...s.databases, ...s.architecture, ...s.languages, ...s.cloud];
  }
}

function scoreOf(skill: string, scores: Record<string, number>): number {
  return scores[skill.toLowerCase()] ?? UNKNOWN_SCORE;
}

/** Weak skills first (lower score = higher priority); stable for equal scores. */
function rankSkills(skills: string[], scores: Record<string, number>): string[] {
  const unique = [...new Map(skills.map((s) => [s.toLowerCase(), s])).values()];
  return unique
    .map((skill, i) => ({ skill, i, score: scoreOf(skill, scores) }))
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.skill);
}

/** The project with the most concrete material to dig into. */
function pickTopProject(projects: PlannerProfile['projects']) {
  return [...projects].sort(
    (a, b) =>
      b.scaleSignals.length * 2 +
      b.technologies.length -
      (a.scaleSignals.length * 2 + a.technologies.length),
  )[0];
}

interface Slot {
  kind: ObjectiveKind;
  share: number;
  difficultyOffset: number;
}

function slotsFor(level: Level, companyType: CompanyType): Slot[] {
  const designKind: ObjectiveKind =
    companyType === 'faang_style' || companyType === 'product'
      ? 'system_design'
      : 'scaling_scenario';

  if (level === 'sde1') {
    return [
      { kind: 'warmup', share: 0.1, difficultyOffset: 0 },
      { kind: 'project_deep_dive', share: 0.35, difficultyOffset: 1 },
      { kind: 'fundamentals', share: 0.25, difficultyOffset: 1 },
      { kind: 'fundamentals', share: 0.2, difficultyOffset: 2 },
      { kind: 'behavioral', share: 0.1, difficultyOffset: 0 },
    ];
  }
  return [
    { kind: 'warmup', share: 0.08, difficultyOffset: 0 },
    { kind: 'project_deep_dive', share: 0.3, difficultyOffset: 1 },
    { kind: 'fundamentals', share: 0.15, difficultyOffset: 1 },
    { kind: designKind, share: 0.22, difficultyOffset: 2 },
    { kind: 'production_debugging', share: 0.17, difficultyOffset: 2 },
    { kind: 'behavioral', share: 0.08, difficultyOffset: 0 },
  ];
}

/**
 * Builds the ordered interview plan: warm up on the candidate's strongest project, go deep on
 * it, then probe their weakest relevant skills, then design/debugging for SDE-2+, then close.
 * Deterministic for a given input so plans are reproducible in tests and support tickets.
 */
export function buildPlan(input: PlannerInput): PlanObjective[] {
  const band = LEVEL_DIFFICULTY_BAND[input.level];
  const project = pickTopProject(input.profile.projects);
  const ranked = rankSkills(roleRelevantSkills(input.profile, input.role), input.skillScores);
  let nextSkill = 0;
  const takeSkill = () => ranked[nextSkill++] ?? DEFAULT_TOPIC[input.role];

  const slots = slotsFor(input.level, input.companyType);
  const totalShare = slots.reduce((sum, s) => sum + s.share, 0);

  return slots.map((slot) => {
    const startDifficulty = Math.min(band.max, band.min + slot.difficultyOffset);
    const timeBudgetSec = Math.round((input.durationSec * slot.share) / totalShare);
    const base = { kind: slot.kind, startDifficulty, timeBudgetSec, isCoreDeepDive: false };

    switch (slot.kind) {
      case 'warmup':
        return {
          ...base,
          topic: project ? `Overview of ${project.name}` : 'Background and recent work',
          technologies: project?.technologies.slice(0, 5) ?? [],
          projectName: project?.name ?? null,
        };
      case 'project_deep_dive':
        return {
          ...base,
          isCoreDeepDive: true,
          topic: project
            ? `Architecture and decisions in ${project.name}`
            : DEFAULT_TOPIC[input.role],
          technologies: project?.technologies ?? [],
          projectName: project?.name ?? null,
        };
      case 'fundamentals': {
        const skill = takeSkill();
        return { ...base, topic: `${skill} in depth`, technologies: [skill], projectName: null };
      }
      case 'system_design':
      case 'scaling_scenario':
        return {
          ...base,
          topic: project
            ? `Scaling ${project.name} 10x`
            : `Designing a system for ${DEFAULT_TOPIC[input.role]}`,
          technologies: project?.technologies ?? [],
          projectName: project?.name ?? null,
        };
      case 'production_debugging':
        return {
          ...base,
          topic: 'Diagnosing a latency regression in production',
          technologies: input.profile.skills.databases.slice(0, 3),
          projectName: project?.name ?? null,
        };
      case 'behavioral':
        return {
          ...base,
          topic: 'Ownership, trade-offs and collaboration',
          technologies: [],
          projectName: null,
        };
    }
  });
}

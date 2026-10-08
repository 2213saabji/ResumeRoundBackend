import type { InterviewAiContext } from '../ai/types.js';
import { profilesRepository } from '../profiles/repository.js';
import type { PlanObjective } from './engine/types.js';
import type { Interview } from './model.js';

/** The stored plan as engine objectives (Mongoose types optional fields as `undefined`). */
export function planOf(i: Interview): PlanObjective[] {
  return i.plan.map((o) => ({
    kind: o.kind,
    topic: o.topic,
    technologies: o.technologies,
    projectName: o.projectName ?? null,
    startDifficulty: o.startDifficulty,
    timeBudgetSec: o.timeBudgetSec,
    isCoreDeepDive: o.isCoreDeepDive,
  }));
}

/** Who is being interviewed, for what: the stable part of every AI request. */
export async function aiContext(i: Interview): Promise<InterviewAiContext> {
  const profile = await profilesRepository.findById(i.profileId.toString());
  return {
    role: i.role,
    level: i.level,
    companyType: i.companyType,
    candidate: {
      experienceYears: profile?.experienceYears ?? 0,
      seniority: profile?.seniority ?? i.level,
      domain: profile?.domain ?? null,
      skills: profile?.skills ?? {},
      projects: (profile?.projects ?? []).map((p) => ({
        name: p.name,
        technologies: p.technologies,
        description: p.description,
        scaleSignals: p.scaleSignals,
      })),
    },
  };
}

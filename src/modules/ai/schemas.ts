import { z } from 'zod';

/**
 * Output contract of the Resume Analyzer. Kept to features structured outputs support
 * (no numeric min/max) - range checks happen in `normalizeResumeAnalysis`.
 */
export const resumeAnalysisSchema = z.object({
  experienceYears: z
    .number()
    .describe('Total professional software experience in years; 0 for students'),
  seniority: z.enum(['sde1', 'sde2', 'senior', 'staff']),
  domain: z
    .string()
    .nullable()
    .describe('Primary business domain, e.g. fintech, e-commerce; null if unclear'),
  skills: z.object({
    languages: z.array(z.string()),
    frameworks: z.array(z.string()),
    databases: z.array(z.string()),
    cloud: z.array(z.string()),
    architecture: z
      .array(z.string())
      .describe('Architecture exposure, e.g. microservices, event-driven, caching, queues'),
  }),
  projects: z.array(
    z.object({
      name: z.string(),
      technologies: z.array(z.string()),
      description: z.string().describe("One or two sentences, in the candidate's own terms"),
      scaleSignals: z
        .array(z.string())
        .describe(
          'Concrete scale facts stated in the resume, e.g. "10k RPS", "2M users"; never invented',
        ),
    }),
  ),
});

export type ResumeAnalysis = z.infer<typeof resumeAnalysisSchema>;

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of values) {
    const v = raw.trim();
    if (v && !seen.has(v.toLowerCase())) {
      seen.add(v.toLowerCase());
      out.push(v);
    }
  }
  return out;
}

/** Clamps and de-duplicates model output before it is stored. */
export function normalizeResumeAnalysis(a: ResumeAnalysis): ResumeAnalysis {
  return {
    ...a,
    experienceYears: Math.min(50, Math.max(0, Math.round(a.experienceYears * 10) / 10)),
    domain: a.domain?.trim() || null,
    skills: {
      languages: dedupe(a.skills.languages),
      frameworks: dedupe(a.skills.frameworks),
      databases: dedupe(a.skills.databases),
      cloud: dedupe(a.skills.cloud),
      architecture: dedupe(a.skills.architecture),
    },
    projects: a.projects.slice(0, 15).map((p) => ({
      name: p.name.trim(),
      technologies: dedupe(p.technologies),
      description: p.description.trim(),
      scaleSignals: dedupe(p.scaleSignals),
    })),
  };
}

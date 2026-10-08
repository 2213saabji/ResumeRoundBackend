import { z } from 'zod';
import { SCORE_DIMENSIONS } from '../../common/domain.js';

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

/** Interviewer output: the question plus the hidden checklist used to score its answer. */
export const questionSpecSchema = z.object({
  question: z
    .string()
    .describe('Exactly what the interviewer says: one question, at most two sentences'),
  expectedConcepts: z
    .array(z.string())
    .describe('3-6 concepts a strong answer at this difficulty covers; hidden from the candidate'),
  goodAnswer: z
    .string()
    .describe('One or two sentences describing a strong answer; hidden from the candidate'),
});

export type QuestionSpec = z.infer<typeof questionSpecSchema>;

export function normalizeQuestionSpec(s: QuestionSpec): QuestionSpec {
  return {
    question: s.question.trim(),
    expectedConcepts: dedupe(s.expectedConcepts).slice(0, 8),
    goodAnswer: s.goodAnswer.trim(),
  };
}

/** Moves the evaluator may suggest. Ending the interview is decided by the controller only. */
export const SUGGESTED_MOVES = [
  'deepen',
  'challenge_vague',
  'clarify',
  'raise_difficulty',
  'hint',
  'reveal_scenario_info',
  'next_objective',
] as const;

const dimensionScore = z
  .number()
  .nullable()
  .describe('0-10, or null when the answer gives no evidence for this dimension');

/** Evaluator output: rubric scores with evidence, plus the suggested next move. */
export const answerEvaluationSchema = z.object({
  dimensionScores: z.object({
    technical_knowledge: dimensionScore,
    problem_solving: dimensionScore,
    system_design: dimensionScore,
    communication: dimensionScore,
    depth: dimensionScore,
    production_thinking: dimensionScore,
  }),
  overall: z.number().describe('0-10 overall quality of this answer at this difficulty'),
  confidence: z.number().describe('0-1 confidence in these scores'),
  isVague: z.boolean(),
  vagueClaim: z.string().nullable().describe('Shortest verbatim quote of the vague claim, or null'),
  coveredConcepts: z.array(z.string()),
  missedConcepts: z.array(z.string()),
  evidence: z.array(
    z.object({
      dimension: z.enum(SCORE_DIMENSIONS),
      quote: z.string().describe('Short verbatim quote from the answer'),
      note: z.string(),
    }),
  ),
  strengths: z.array(z.string()).describe('0-2 short skill-level phrases, only if clearly shown'),
  weaknesses: z.array(z.string()).describe('0-2 short skill-level phrases, only if clearly shown'),
  suggestedMove: z.enum(SUGGESTED_MOVES),
  suggestedDifficultyChange: z.number().int().describe('Integer from -2 to 2'),
  focusConcept: z
    .string()
    .nullable()
    .describe('Concept the next question should target (for deepen / hint), or null'),
  reason: z.string().describe('One sentence explaining the suggested move'),
});

export type AnswerEvaluation = z.infer<typeof answerEvaluationSchema>;

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));
const round1 = (v: number) => Math.round(v * 10) / 10;

export function normalizeAnswerEvaluation(e: AnswerEvaluation): AnswerEvaluation {
  const dimensionScores = Object.fromEntries(
    Object.entries(e.dimensionScores).map(([k, v]) => [
      k,
      v === null || !Number.isFinite(v) ? null : round1(clamp(v, 0, 10)),
    ]),
  ) as AnswerEvaluation['dimensionScores'];
  return {
    ...e,
    dimensionScores,
    overall: round1(clamp(e.overall, 0, 10)),
    confidence: Math.round(clamp(e.confidence, 0, 1) * 100) / 100,
    vagueClaim: e.isVague ? e.vagueClaim?.trim() || null : null,
    coveredConcepts: dedupe(e.coveredConcepts).slice(0, 10),
    missedConcepts: dedupe(e.missedConcepts).slice(0, 10),
    evidence: e.evidence.slice(0, 3),
    strengths: dedupe(e.strengths).slice(0, 2),
    weaknesses: dedupe(e.weaknesses).slice(0, 2),
    suggestedDifficultyChange: clamp(Math.round(e.suggestedDifficultyChange), -2, 2),
    focusConcept: e.focusConcept?.trim() || null,
  };
}

/** Report Writer output. Scores are computed in code; the model only writes the narrative. */
export const reportNarrativeSchema = z.object({
  strengths: z
    .array(z.string())
    .describe('2-5 specific strengths, each grounded in what the candidate actually said'),
  weaknesses: z
    .array(z.string())
    .describe('2-5 specific gaps, each grounded in what the candidate said or missed'),
  feedback: z
    .string()
    .describe('Interviewer feedback: one or two short paragraphs, direct and constructive'),
  recommendations: z
    .array(
      z.object({
        topic: z.string(),
        reason: z.string().describe('Why, tied to this interview'),
        resources: z
          .array(z.string())
          .describe('2-3 study suggestions such as "PostgreSQL docs: Indexes chapter"; no URLs'),
      }),
    )
    .describe('3-6 topics to study next, most important first'),
});

export type ReportNarrative = z.infer<typeof reportNarrativeSchema>;

export function normalizeReportNarrative(r: ReportNarrative): ReportNarrative {
  return {
    strengths: dedupe(r.strengths).slice(0, 6),
    weaknesses: dedupe(r.weaknesses).slice(0, 6),
    feedback: r.feedback.trim(),
    recommendations: r.recommendations.slice(0, 6).map((rec) => ({
      topic: rec.topic.trim(),
      reason: rec.reason.trim(),
      resources: dedupe(rec.resources).slice(0, 4),
    })),
  };
}

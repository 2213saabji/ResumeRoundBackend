import type { Level } from '../../../common/domain.js';
import { isRepeatQuestion } from '../../interviews/engine/question-repeat.js';
import {
  normalizeAnswerEvaluation,
  normalizeQuestionSpec,
  normalizeReportNarrative,
  normalizeResumeAnalysis,
  type AnswerEvaluation,
  type QuestionSpec,
  type ReportNarrative,
  type ResumeAnalysis,
} from '../schemas.js';
import type {
  AiCallContext,
  AiGateway,
  EvaluationRequest,
  QuestionRequest,
  ReportRequest,
} from '../types.js';

const DICTIONARY: Record<keyof ResumeAnalysis['skills'], string[]> = {
  languages: [
    'JavaScript',
    'TypeScript',
    'Python',
    'Java',
    'Go',
    'Rust',
    'C++',
    'C#',
    'Kotlin',
    'Ruby',
    'PHP',
    'SQL',
  ],
  frameworks: [
    'Node.js',
    'Express',
    'NestJS',
    'React',
    'Next.js',
    'Vue',
    'Angular',
    'Django',
    'Flask',
    'FastAPI',
    'Spring Boot',
    'Redux',
    'GraphQL',
  ],
  databases: [
    'PostgreSQL',
    'MySQL',
    'MongoDB',
    'Redis',
    'Elasticsearch',
    'DynamoDB',
    'Cassandra',
    'SQLite',
  ],
  cloud: ['AWS', 'GCP', 'Azure', 'Docker', 'Kubernetes', 'Terraform', 'Vercel', 'Lambda', 'S3'],
  architecture: [
    'microservices',
    'event-driven',
    'caching',
    'message queue',
    'Kafka',
    'RabbitMQ',
    'REST',
    'gRPC',
    'CI/CD',
  ],
};

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mentions(text: string, term: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegex(term)}($|[^A-Za-z0-9])`, 'i').test(text);
}

function seniorityFor(years: number): Level {
  if (years >= 8) return 'staff';
  if (years >= 5) return 'senior';
  if (years >= 2) return 'sde2';
  return 'sde1';
}

function firstQuestionFor(req: QuestionRequest): string {
  const o = req.objective;
  const tech = o.technologies[0] ?? 'the main technology you used';
  const project = o.projectName ?? 'your most recent project';
  switch (o.kind) {
    case 'warmup':
      return `Let's start with ${project}. Walk me through what it does and what you owned in it.`;
    case 'project_deep_dive':
      return `In ${project}, why did you choose ${tech}, and what trade-offs did you consider?`;
    case 'fundamentals':
      return `Let's switch to ${tech}. How does it work under the hood, and where have you hit its limits?`;
    case 'system_design':
    case 'scaling_scenario':
      return `Let's design: ${o.topic}. What are the main components, and how would they scale?`;
    case 'production_debugging':
      return 'After a deploy, the p95 latency of your main API jumped from 200 ms to 1.4 s. How do you investigate?';
    case 'behavioral':
      return 'Tell me about a time you disagreed with a technical decision. What did you do?';
  }
}

/** Template questions for a move, filled from the objective, project, technology and focus. */
function questionVariants(req: QuestionRequest): string[] {
  const o = req.objective;
  const techs = o.technologies.length ? o.technologies : ['the main technology you used'];
  const tech = techs[req.askedQuestions.length % techs.length]!;
  const focus = req.focusConcept ?? tech;
  const project = o.projectName ?? 'your most recent project';
  const claim = req.vagueClaim ?? 'that';
  switch (req.move) {
    case 'opening':
      return [firstQuestionFor(req)];
    case 'next_objective':
      return [`Let's move on. ${firstQuestionFor(req)}`, `Next topic. ${firstQuestionFor(req)}`];
    case 'deepen':
      return [
        `Can you go deeper on ${focus}? What exactly happens there?`,
        `Let's stay on ${focus} for a moment. How did you test or measure it in ${project}?`,
        `What was the hardest problem you hit with ${focus}, and how did you solve it?`,
        `If you rebuilt that part of ${project} today, what would you change about ${focus}, and why?`,
      ];
    case 'raise_difficulty':
      return [
        `Now suppose traffic to ${project} grows 10x. What breaks first, and how would you handle it?`,
        `What happens in ${project} if ${tech} is unavailable for five minutes at peak load?`,
        `How would ${project} change if it had to run in two regions with strict consistency?`,
        `Suppose the p99 latency budget for ${project} drops to 100 ms. What would you change first?`,
      ];
    case 'challenge_vague':
      return [
        `You said "${claim}". What exactly did you change, and how did you measure it?`,
        `Can you put numbers on "${claim}"? What were the before and after values?`,
      ];
    case 'hint':
      return [
        `Here's a hint: think about ${focus}. How would that change your answer?`,
        `Consider what ${focus} does under load. Does that change your approach?`,
      ];
    case 'clarify':
      return [
        'I want to make sure I understood. Could you explain that again with a concrete example?',
        'Could you walk me through that step by step, with a specific example from your work?',
      ];
    case 'reveal_scenario_info':
      return [
        'New information: database CPU is at 85% while the query itself takes 20 ms. What do you check next?',
        'New information: the slowdown only happens during the nightly batch job. What does that tell you?',
        'New information: connection pool wait time is 900 ms at peak. What would you do?',
      ];
    case 'wrap_up':
      return ['Is there anything you would like to add before we finish?'];
  }
}

/**
 * Deterministic, offline stand-in for local development and tests (AI_PROVIDER=mock).
 * Keyword matching and templates only - not a substitute for the real model's quality.
 */
export class MockProvider implements AiGateway {
  readonly provider = 'mock';

  async analyzeResume(resumeText: string, _ctx: AiCallContext): Promise<ResumeAnalysis> {
    const years = Number(/(\d+(?:\.\d+)?)\+?\s*(?:years|yrs)/i.exec(resumeText)?.[1] ?? 0);
    const skills = Object.fromEntries(
      Object.entries(DICTIONARY).map(([bucket, terms]) => [
        bucket,
        terms.filter((t) => mentions(resumeText, t)),
      ]),
    ) as ResumeAnalysis['skills'];

    const allTech = Object.values(skills).flat();
    const projects = [...resumeText.matchAll(/^\s*project:\s*(.+)$/gim)].map((m) => ({
      name: m[1]!.trim(),
      technologies: allTech.slice(0, 4),
      description: m[1]!.trim(),
      scaleSignals: [],
    }));

    return normalizeResumeAnalysis({
      experienceYears: years,
      seniority: seniorityFor(years),
      domain: null,
      skills,
      projects,
    });
  }

  async generateQuestion(req: QuestionRequest, _ctx: AiCallContext): Promise<QuestionSpec> {
    // Rotate through the variants and skip any that was already asked, like the real model does.
    const variants = questionVariants(req);
    const offset = req.askedQuestions.length + (req.avoidRepeat ? 1 : 0);
    const rotated = variants.map((_, i) => variants[(offset + i) % variants.length]!);
    const question = rotated.find((q) => !isRepeatQuestion(q, req.askedQuestions)) ?? rotated[0]!;
    return normalizeQuestionSpec({
      question,
      expectedConcepts: req.objective.technologies.length
        ? req.objective.technologies.slice(0, 4)
        : ['trade-offs', 'failure modes', 'measurement'],
      goodAnswer: 'Specific, correct, explains trade-offs and how it was measured.',
    });
  }

  async evaluateAnswer(req: EvaluationRequest, _ctx: AiCallContext): Promise<AnswerEvaluation> {
    const words = req.answer.trim().split(/\s+/).filter(Boolean).length;
    const covered = req.expectedConcepts.filter((c) => mentions(req.answer, c));
    // Length helps a little; covering the expected concepts is what earns a high score.
    const overall = Math.min(10, 3 + Math.min(3, Math.floor(words / 15)) + 2 * covered.length);
    const isVague = words < 12;
    const confidence = words < 3 ? 0.3 : 0.9;
    const suggestedMove: AnswerEvaluation['suggestedMove'] = isVague
      ? 'challenge_vague'
      : overall >= 8
        ? 'raise_difficulty'
        : overall <= 3
          ? 'hint'
          : 'deepen';
    const missed = req.expectedConcepts.filter((c) => !covered.includes(c));

    return normalizeAnswerEvaluation({
      dimensionScores: {
        technical_knowledge: overall,
        problem_solving: null,
        system_design: null,
        communication: Math.min(10, overall + 1),
        depth: null,
        production_thinking: null,
      },
      overall,
      confidence,
      isVague,
      vagueClaim: isVague ? req.answer.trim().slice(0, 80) : null,
      coveredConcepts: covered,
      missedConcepts: missed,
      evidence: [
        { dimension: 'technical_knowledge', quote: req.answer.trim().slice(0, 80), note: 'mock' },
      ],
      strengths: covered.slice(0, 1),
      weaknesses: missed.slice(0, 1),
      suggestedMove,
      suggestedDifficultyChange: suggestedMove === 'raise_difficulty' ? 2 : 0,
      focusConcept: missed[0] ?? null,
      reason: `mock evaluator: ${words} words, ${covered.length} expected concepts covered`,
    });
  }

  async generateReport(req: ReportRequest, _ctx: AiCallContext): Promise<ReportNarrative> {
    const ranked = Object.entries(req.dimensionScores).sort((a, b) => b[1] - a[1]);
    const label = (d: string) => d.replace(/_/g, ' ');
    const missed = [...new Set(req.turns.flatMap((t) => t.missedConcepts))];
    return normalizeReportNarrative({
      strengths: ranked.slice(0, 2).map(([d, v]) => `Strongest area: ${label(d)} (${v}/10)`),
      weaknesses: [
        ...ranked.slice(-1).map(([d, v]) => `Weakest area: ${label(d)} (${v}/10)`),
        ...missed.slice(0, 2).map((c) => `Did not cover: ${c}`),
      ],
      feedback: `You answered ${req.turns.length} questions with an overall score of ${req.overall}/10. Focus first on the topics listed under recommendations.`,
      recommendations: (missed.length ? missed : ['system design trade-offs'])
        .slice(0, 3)
        .map((topic) => ({
          topic,
          reason: 'It came up in your interview and your answers did not cover it.',
          resources: [
            `Official documentation: ${topic}`,
            `Hands-on: build a small demo using ${topic}`,
          ],
        })),
    });
  }
}

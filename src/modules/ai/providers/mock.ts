import type { Level } from '../../../common/domain.js';
import { normalizeResumeAnalysis, type ResumeAnalysis } from '../schemas.js';
import type { AiCallContext, AiGateway } from '../types.js';

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

/**
 * Deterministic, offline stand-in for local development and tests (AI_PROVIDER=mock).
 * Keyword matching only - not a substitute for the real analyzer's quality.
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
}

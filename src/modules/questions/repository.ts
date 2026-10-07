import { createCache } from '../../common/cache.js';
import type { Level } from '../../common/domain.js';
import { QuestionModel, RubricModel, type Question, type Rubric } from './model.js';

/** Name of the Atlas Vector Search index on questions.embedding. */
export const QUESTION_VECTOR_INDEX = 'questions_embedding';

const rubricCache = createCache<Rubric>({ max: 200 });

export interface QuestionSearch {
  embedding: number[];
  category?: string;
  level?: Level;
  minDifficulty: number;
  maxDifficulty: number;
  excludeIds?: string[];
  limit?: number;
}

export const questionsRepository = {
  /** Semantic retrieval, pre-filtered by category / seniority / difficulty band. */
  async vectorSearch(q: QuestionSearch): Promise<(Question & { score: number })[]> {
    const limit = q.limit ?? 5;
    const filter: Record<string, unknown> = {
      isActive: true,
      difficulty: { $gte: q.minDifficulty, $lte: q.maxDifficulty },
    };
    if (q.category) filter.category = q.category;
    if (q.level) filter.seniority = q.level;

    const excluded = new Set(q.excludeIds ?? []);
    const rows = await QuestionModel.aggregate<Question & { score: number }>([
      {
        $vectorSearch: {
          index: QUESTION_VECTOR_INDEX,
          path: 'embedding',
          queryVector: q.embedding,
          numCandidates: Math.max(100, limit * 20),
          limit: limit + excluded.size,
          filter,
        },
      },
      { $project: { embedding: 0, score: { $meta: 'vectorSearchScore' } } },
    ]);
    return rows.filter((r) => !excluded.has(r._id.toString())).slice(0, limit);
  },

  async getRubric(id: string): Promise<Rubric | null> {
    const cached = rubricCache.get(id);
    if (cached) return cached;
    const rubric = await RubricModel.findById(id).lean<Rubric>();
    if (rubric) rubricCache.set(id, rubric);
    return rubric;
  },
};

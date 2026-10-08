import { SCORE_DIMENSIONS, type ScoreDimension } from '../../common/domain.js';

/** Fewer scored answers than this and the report would be noise; the user is told instead. */
export const MIN_ANSWERS_FOR_REPORT = 2;

/** Low-confidence answers (the controller asked to clarify) still count, but barely. */
const MIN_WEIGHT = 0.1;

export interface ScoredTurn {
  dimensionScores: Record<string, number>;
  overall: number;
  /** Evaluator confidence, 0-1; used as the weight. */
  confidence: number;
  /** Technologies of the plan objective the question belonged to. */
  technologies: string[];
}

export interface AggregatedScores {
  /** Only dimensions at least one answer gave evidence for. */
  dimensionScores: Partial<Record<ScoreDimension, number>>;
  overall: number;
  /** Per technology (display name as in the plan), for skill history and the next plan. */
  skillScores: Record<string, number>;
}

const round1 = (v: number) => Math.round(v * 10) / 10;

class WeightedMean {
  private sum = 0;
  private weight = 0;
  add(value: number, weight: number) {
    this.sum += value * weight;
    this.weight += weight;
  }
  get value(): number | null {
    return this.weight > 0 ? round1(this.sum / this.weight) : null;
  }
}

/**
 * Final scores are computed here, never by the LLM, so re-scoring the same transcript always
 * yields the same numbers (PRD: re-score delta <= 0.5).
 */
export function aggregateScores(turns: ScoredTurn[]): AggregatedScores {
  const overall = new WeightedMean();
  const dimensions = new Map<string, WeightedMean>();
  const skills = new Map<string, { name: string; mean: WeightedMean }>();

  for (const t of turns) {
    const w = Math.max(MIN_WEIGHT, Math.min(1, t.confidence));
    overall.add(t.overall, w);
    for (const [dimension, score] of Object.entries(t.dimensionScores)) {
      if (!Number.isFinite(score)) continue;
      if (!dimensions.has(dimension)) dimensions.set(dimension, new WeightedMean());
      dimensions.get(dimension)!.add(score, w);
    }
    for (const tech of t.technologies) {
      const key = tech.toLowerCase();
      if (!skills.has(key)) skills.set(key, { name: tech, mean: new WeightedMean() });
      skills.get(key)!.mean.add(t.overall, w);
    }
  }

  const dimensionScores: Partial<Record<ScoreDimension, number>> = {};
  for (const d of SCORE_DIMENSIONS) {
    const v = dimensions.get(d)?.value;
    if (v !== null && v !== undefined) dimensionScores[d] = v;
  }

  return {
    dimensionScores,
    overall: overall.value ?? 0,
    skillScores: Object.fromEntries(
      [...skills.values()].map(({ name, mean }) => [name, mean.value ?? 0]),
    ),
  };
}

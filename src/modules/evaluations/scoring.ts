export interface RubricDimension {
  key: string;
  weight: number;
}

/**
 * Weighted 0-10 score from per-dimension scores. Dimensions the evaluator did not score are
 * left out and the remaining weights re-normalised, so a missing dimension never counts as 0.
 */
export function weightedScore(
  dimensionScores: Record<string, number>,
  dimensions: RubricDimension[],
): number | null {
  let weighted = 0;
  let totalWeight = 0;
  for (const d of dimensions) {
    const score = dimensionScores[d.key];
    if (score === undefined || !Number.isFinite(score) || d.weight <= 0) continue;
    weighted += Math.max(0, Math.min(10, score)) * d.weight;
    totalWeight += d.weight;
  }
  if (totalWeight === 0) return null;
  return Math.round((weighted / totalWeight) * 10) / 10;
}

/** Exponential moving average used for the interview's running per-dimension scores. */
export function updateRunningScore(
  previous: number | undefined,
  latest: number,
  alpha = 0.4,
): number {
  if (previous === undefined) return latest;
  return Math.round((alpha * latest + (1 - alpha) * previous) * 10) / 10;
}

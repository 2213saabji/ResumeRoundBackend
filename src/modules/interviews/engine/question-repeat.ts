/** Two questions sharing at least this share of their words count as the same question. */
const SIMILARITY_THRESHOLD = 0.8;

// prettier-ignore
const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'did', 'do', 'does', 'for', 'how', 'i', 'in', 'is', 'it', 'of', 'on',
  'or', 'that', 'the', 'this', 'to', 'was', 'what', 'would', 'you', 'your',
]);

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w && !STOP_WORDS.has(w)),
  );
}

/** Jaccard similarity of the meaningful words of two questions, 0-1. */
export function questionSimilarity(a: string, b: string): number {
  const wa = words(a);
  const wb = words(b);
  if (!wa.size || !wb.size) return a.trim().toLowerCase() === b.trim().toLowerCase() ? 1 : 0;
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / (wa.size + wb.size - shared);
}

/** True when `candidate` is the same question as one already asked (exactly or near-verbatim). */
export function isRepeatQuestion(candidate: string, asked: string[]): boolean {
  return asked.some((q) => questionSimilarity(candidate, q) >= SIMILARITY_THRESHOLD);
}

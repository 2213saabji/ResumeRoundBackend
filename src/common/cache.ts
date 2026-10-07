import { LRUCache } from 'lru-cache';

/** In-process hot cache (questions, rubrics, prompts). Replaces Redis for read-mostly data. */
export function createCache<V extends NonNullable<unknown>>(
  options: { max?: number; ttlMs?: number } = {},
) {
  return new LRUCache<string, V>({
    max: options.max ?? 1_000,
    ttl: options.ttlMs ?? 5 * 60 * 1000,
  });
}

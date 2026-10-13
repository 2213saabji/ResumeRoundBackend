import { SpeechError } from './types.js';

/**
 * Runs a provider request, retrying once after rate limits, server errors and network
 * failures. Anything else (bad key, unknown voice) fails at once.
 */
export async function retryOnce<T>(label: string, request: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await request();
    } catch (err) {
      const retryable = !(err instanceof SpeechError) || err.retryable;
      if (!retryable || attempt >= 2) {
        throw err instanceof SpeechError
          ? err
          : new SpeechError(`${label} request failed: ${String(err)}`, true);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

/** A SpeechError for a non-2xx response; 429 and 5xx are retryable. */
export async function httpError(label: string, res: Response): Promise<SpeechError> {
  const detail = await res.text().catch(() => '');
  const retryable = res.status === 429 || res.status >= 500;
  return new SpeechError(`${label} HTTP ${res.status}: ${detail.slice(0, 300)}`, retryable);
}

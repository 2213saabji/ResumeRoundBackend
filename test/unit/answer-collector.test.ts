import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnswerCollector } from '../../src/modules/media/answer-collector.js';

describe('AnswerCollector', () => {
  let updates: string[];
  let done: string[];
  let c: AnswerCollector;

  beforeEach(() => {
    vi.useFakeTimers();
    updates = [];
    done = [];
    c = new AnswerCollector(
      (t) => updates.push(t),
      (t) => done.push(t),
      { graceMs: 700, shortAnswerWaitMs: 6_000, minWords: 4 },
    );
  });
  afterEach(() => vi.useRealTimers());

  it('joins finals and the current partial for live captions', () => {
    c.finalResult('We used Kafka');
    c.partialResult('for the order');
    expect(updates.at(-1)).toBe('We used Kafka for the order');
    c.finalResult('for the order events.');
    expect(c.text).toBe('We used Kafka for the order events.');
  });

  it('submits after the grace period once the speaker pauses', () => {
    c.finalResult('We sharded Postgres by tenant ID.');
    c.utteranceEnded();
    vi.advanceTimersByTime(699);
    expect(done).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(done).toEqual(['We sharded Postgres by tenant ID.']);
    // Kept until reset, so results that arrive while the caller flushes still count.
    c.finalResult('By region too.');
    expect(c.text).toBe('We sharded Postgres by tenant ID. By region too.');
  });

  it('keeps listening when the speaker carries on', () => {
    c.finalResult('First we cached the reads.');
    c.utteranceEnded();
    vi.advanceTimersByTime(500);
    c.speechStarted();
    c.partialResult('Then we');
    vi.advanceTimersByTime(5_000);
    expect(done).toEqual([]);
    c.finalResult('Then we added a queue.');
    c.utteranceEnded();
    vi.advanceTimersByTime(700);
    expect(done).toEqual(['First we cached the reads. Then we added a queue.']);
  });

  it('waits longer after a short "let me think"', () => {
    c.finalResult('Let me think.');
    c.utteranceEnded();
    vi.advanceTimersByTime(3_000);
    expect(done).toEqual([]);
    c.finalResult('I would put a cache in front of the database.');
    c.utteranceEnded();
    vi.advanceTimersByTime(700);
    expect(done).toEqual(['Let me think. I would put a cache in front of the database.']);
  });

  it('still submits a short answer if nothing follows', () => {
    c.finalResult("I don't know.");
    c.utteranceEnded();
    vi.advanceTimersByTime(6_000);
    expect(done).toEqual(["I don't know."]);
  });

  it('ignores a pause with no words, and forgets everything on reset', () => {
    c.utteranceEnded();
    vi.advanceTimersByTime(10_000);
    c.finalResult('Stale words.');
    c.utteranceEnded();
    c.reset();
    vi.advanceTimersByTime(10_000);
    expect(done).toEqual([]);
  });
});

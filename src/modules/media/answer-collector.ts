export interface AnswerCollectorOptions {
  /**
   * Extra silence after the speech-to-text word gap (itself about 1 s after the last word)
   * before the answer counts as finished. Any new speech in that window cancels it.
   */
  graceMs: number;
  /**
   * Answers shorter than `minWords` ("let me think", "hmm, okay") wait this long instead, so a
   * candidate can pause to think without the interviewer jumping in.
   */
  shortAnswerWaitMs: number;
  minWords: number;
}

export const DEFAULT_COLLECTOR: AnswerCollectorOptions = {
  graceMs: 300,
  shortAnswerWaitMs: 6_000,
  minWords: 4,
};

const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Builds the candidate's answer from streaming transcripts and decides when they have finished
 * talking. Pure turn-taking logic, separate from audio and Janus, so it can be tested alone.
 */
export class AnswerCollector {
  private finals: string[] = [];
  private partial = '';
  private timer?: NodeJS.Timeout;
  private readonly opts: AnswerCollectorOptions;

  constructor(
    /** Live transcript of the answer so far (for captions). */
    private readonly onUpdate: (text: string) => void,
    /**
     * The candidate seems to have finished. The text so far is kept (late results still
     * append to it) until reset(), so the caller can flush the recogniser first.
     */
    private readonly onDone: (text: string) => void,
    opts: Partial<AnswerCollectorOptions> = {},
  ) {
    this.opts = { ...DEFAULT_COLLECTOR, ...opts };
  }

  get text(): string {
    return [...this.finals, this.partial].join(' ').replace(/\s+/g, ' ').trim();
  }

  partialResult(text: string): void {
    this.cancel();
    this.partial = text;
    this.onUpdate(this.text);
  }

  finalResult(text: string): void {
    this.cancel();
    this.finals.push(text);
    this.partial = '';
    this.onUpdate(this.text);
  }

  speechStarted(): void {
    this.cancel();
  }

  /** The speech-to-text service detected a pause after the last word. */
  utteranceEnded(): void {
    const answer = this.text;
    if (!answer) return;
    this.cancel();
    const wait =
      wordCount(answer) >= this.opts.minWords ? this.opts.graceMs : this.opts.shortAnswerWaitMs;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.text) this.onDone(this.text);
    }, wait);
  }

  /** Forget everything (a new question was asked). */
  reset(): void {
    this.cancel();
    this.finals = [];
    this.partial = '';
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}

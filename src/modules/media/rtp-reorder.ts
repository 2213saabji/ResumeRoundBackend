/**
 * Puts incoming RTP payloads back in sequence-number order before decoding. Packets that
 * arrive in order pass straight through (no added delay); one that arrives early waits for
 * the missing ones, for at most `maxHeld` packets, after which the gap counts as lost and is
 * reported so the caller can fill it with silence (keeping the audio timeline intact, which
 * speech-to-text needs). Late duplicates and packets that were already given up on are dropped.
 */
export class RtpReorder {
  private expected: number | null = null;
  private readonly held = new Map<number, Buffer>();

  constructor(
    private readonly emit: (payload: Buffer | null) => void,
    /** 3 packets = 60 ms at 20 ms per packet. */
    private readonly maxHeld = 3,
  ) {}

  push(seq: number, payload: Buffer): void {
    if (this.expected === null) this.expected = seq;
    const ahead = (seq - this.expected) & 0xffff;
    // More than half the sequence space ahead means behind (wrapped): late or duplicate.
    if (ahead >= 0x8000) return;
    if (ahead === 0) {
      this.deliver(payload);
      this.drain();
      return;
    }
    this.held.set(seq, payload);
    if (this.held.size > this.maxHeld) this.skipGap();
  }

  private deliver(payload: Buffer | null): void {
    this.emit(payload);
    this.expected = ((this.expected ?? 0) + 1) & 0xffff;
  }

  private drain(): void {
    for (let next = this.held.get(this.expected!); next; next = this.held.get(this.expected!)) {
      this.held.delete(this.expected!);
      this.deliver(next);
    }
  }

  /** Gives up on the missing packets before the earliest held one. */
  private skipGap(): void {
    while (!this.held.has(this.expected!)) this.deliver(null);
    this.drain();
  }
}

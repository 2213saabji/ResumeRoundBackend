const FRAME_MS = 20;
/**
 * Further behind schedule than this means playback really paused (e.g. between sentences);
 * anything less is timer lateness, caught up by sending the next frames sooner.
 */
export const RESUME_AFTER_MS = 100;

export interface PacerClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: PacerClock = {
  now: () => performance.now(),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
};

/**
 * Sends 20 ms audio frames on one real-time grid across many play() calls. Timers wake late
 * (on Windows by up to ~16 ms), so restarting the grid whenever it is behind would throw that
 * lateness away on every call: audio streamed in small pieces then goes out at ~85% of real
 * time, Janus runs out of it, and the listener hears holes in the interviewer's voice.
 */
export class FramePacer {
  private nextFrameAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly clock: PacerClock = realClock) {}

  /** Call before the first frame of each play(). True after a real pause: a new talkspurt. */
  start(): boolean {
    const now = this.clock.now();
    if (this.nextFrameAt >= now - RESUME_AFTER_MS) return false;
    this.nextFrameAt = now;
    return true;
  }

  /** Call after sending each frame; waits until the next one is due. */
  async frameSent(): Promise<void> {
    this.nextFrameAt += FRAME_MS;
    const wait = this.nextFrameAt - this.clock.now();
    if (wait > 0) await this.clock.sleep(wait);
  }
}

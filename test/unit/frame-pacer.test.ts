import { describe, expect, it } from 'vitest';
import {
  FramePacer,
  RESUME_AFTER_MS,
  type PacerClock,
} from '../../src/modules/media/frame-pacer.js';

/** A clock whose timers wake on Windows-like ~15.6 ms ticks, i.e. late. */
function coarseClock() {
  const TICK = 15.625;
  const clock = {
    t: 1_000,
    now: () => clock.t,
    sleep: async (ms: number) => {
      clock.t += Math.ceil(ms / TICK) * TICK;
    },
  };
  return clock satisfies PacerClock;
}

/** Plays `pieces` audio pieces of `frames` frames each, back to back, like streamed TTS. */
async function playPieces(pacer: FramePacer, pieces: number, frames: number) {
  let talkspurts = 0;
  for (let p = 0; p < pieces; p++) {
    if (pacer.start()) talkspurts++;
    for (let f = 0; f < frames; f++) await pacer.frameSent();
  }
  return talkspurts;
}

describe('FramePacer', () => {
  it('keeps real time across many small pieces even when timers wake late', async () => {
    const clock = coarseClock();
    const pacer = new FramePacer(clock);
    const started = clock.t;

    // 250 pieces x 2 frames = 10 s of audio.
    const talkspurts = await playPieces(pacer, 250, 2);

    expect(talkspurts).toBe(1);
    expect(clock.t - started).toBeGreaterThanOrEqual(10_000);
    expect(clock.t - started).toBeLessThan(10_000 + 20);
  });

  it('starts a new talkspurt after a real pause', async () => {
    const clock = coarseClock();
    const pacer = new FramePacer(clock);
    await playPieces(pacer, 5, 2);

    clock.t += RESUME_AFTER_MS + 50; // e.g. waiting for the next sentence
    expect(pacer.start()).toBe(true);

    await pacer.frameSent();
    clock.t += 30; // timer lateness, not a pause
    expect(pacer.start()).toBe(false);
  });
});

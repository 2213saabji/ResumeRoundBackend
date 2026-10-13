import { describe, expect, it } from 'vitest';
import { tidyTranscript } from '../../src/modules/media/interview-call.js';
import { RtpReorder } from '../../src/modules/media/rtp-reorder.js';

function run(seqs: number[], maxHeld = 3) {
  const out: (number | null)[] = [];
  const r = new RtpReorder((p) => out.push(p ? p.readUInt16BE(0) : null), maxHeld);
  for (const seq of seqs) {
    const b = Buffer.alloc(2);
    b.writeUInt16BE(seq);
    r.push(seq, b);
  }
  return out;
}

describe('RtpReorder', () => {
  it('passes in-order packets straight through', () => {
    expect(run([10, 11, 12])).toEqual([10, 11, 12]);
  });

  it('reorders a packet that arrives early', () => {
    expect(run([10, 12, 11, 13])).toEqual([10, 11, 12, 13]);
  });

  it('fills a lost packet with a gap once enough later ones arrive', () => {
    expect(run([10, 12, 13, 14, 15])).toEqual([10, null, 12, 13, 14, 15]);
  });

  it('drops late duplicates and packets already given up on', () => {
    expect(run([10, 11, 11, 13, 14, 15, 16, 12])).toEqual([10, 11, null, 13, 14, 15, 16]);
  });

  it('handles the 16-bit sequence wrap', () => {
    expect(run([65534, 0, 65535, 1])).toEqual([65534, 65535, 0, 1]);
  });
});

describe('tidyTranscript', () => {
  it('rejoins split technology names', () => {
    expect(tidyTranscript('I used Node. Js with Next. js and nodejs')).toBe(
      'I used Node.js with Next.js and nodejs',
    );
  });
});

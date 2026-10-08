import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import OpusScript from 'opusscript';

export const SAMPLE_RATE = 48_000;
export const FRAME_SAMPLES = 960; // 20 ms

export function createOpus() {
  return new OpusScript(SAMPLE_RATE, 1, OpusScript.Application.VOIP);
}

export function toInt16(buf: Buffer): Int16Array {
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

export function rmsDbfs(pcm: Int16Array): number {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return 10 * Math.log10(sum / Math.max(1, pcm.length) / (32768 * 32768) + 1e-12);
}

/** Mono 16-bit PCM from a WAV file (first channel), resampled to 48 kHz (linear). */
function readWav48k(path: string): Int16Array {
  const buf = readFileSync(path);
  let offset = 12;
  let rate = 0;
  let channels = 1;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      rate = buf.readUInt32LE(offset + 12);
    } else if (id === 'data') {
      const end = Math.min(buf.length, offset + 8 + size);
      const frames = Math.floor((end - offset - 8) / (2 * channels));
      const src = new Int16Array(frames);
      for (let i = 0; i < frames; i++) src[i] = buf.readInt16LE(offset + 8 + i * 2 * channels);
      const ratio = rate / SAMPLE_RATE;
      const out = new Int16Array(Math.floor(frames / ratio));
      for (let i = 0; i < out.length; i++) {
        const pos = i * ratio;
        const j = Math.floor(pos);
        const a = src[j] ?? 0;
        const b = src[j + 1] ?? a;
        out[i] = Math.round(a + (b - a) * (pos - j));
      }
      return out;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${path}`);
}

/** Spoken reply clip, synthesised with espeak-ng (stands in for streaming TTS in the spike). */
export function synthesize(text: string): Int16Array {
  const path = join(tmpdir(), `spike-reply-${process.pid}.wav`);
  try {
    execFileSync('espeak-ng', ['-v', 'en-us', '-s', '165', '-w', path, text]);
    return readWav48k(path);
  } finally {
    rmSync(path, { force: true });
  }
}

/** CPU (% of one core) and memory of this process since the previous call. */
export function cpuSampler() {
  let prev = process.cpuUsage();
  let prevAt = performance.now();
  return () => {
    const now = performance.now();
    const used = process.cpuUsage(prev);
    const cpuPctOfCore = ((used.user + used.system) / 1000 / (now - prevAt)) * 100;
    prev = process.cpuUsage();
    prevAt = now;
    return {
      cpuPctOfCore: Number(cpuPctOfCore.toFixed(2)),
      rssMb: Math.round(process.memoryUsage().rss / 1e6),
    };
  };
}

export function log(label: string, event: string, data: Record<string, unknown> = {}) {
  process.stdout.write(
    `${JSON.stringify({ t: new Date().toISOString(), bot: label, event, ...data })}\n`,
  );
}

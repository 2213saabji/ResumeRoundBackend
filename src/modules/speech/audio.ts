/**
 * Audio helpers shared by the speech providers. Every interview room runs at 16 kHz mono
 * (see docs/spikes/janus-audio-bridge.md), so speech-to-text input and text-to-speech output
 * are both 16 kHz, 16-bit, mono PCM.
 */
export const SPEECH_SAMPLE_RATE = 16_000;
/** 20 ms at 16 kHz: one Opus frame from the room. */
export const FRAME_SAMPLES = 320;

export function durationMs(pcm: Int16Array, sampleRate = SPEECH_SAMPLE_RATE): number {
  return (pcm.length / sampleRate) * 1000;
}

/** Loudness of a frame in dBFS (0 = full scale, about -90 = digital silence). */
export function rmsDbfs(pcm: Int16Array): number {
  let sum = 0;
  for (const s of pcm) sum += s * s;
  return 10 * Math.log10(sum / Math.max(1, pcm.length) / (32768 * 32768) + 1e-12);
}

export function pcmToBytes(pcm: Int16Array): Buffer {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
}

/** Copies, so the result is aligned whatever the source buffer's offset. */
export function bytesToPcm(bytes: Buffer): Int16Array {
  const out = new Int16Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = bytes.readInt16LE(i * 2);
  return out;
}

export function concatPcm(parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Linear-interpolation resampler; good enough for speech. */
export function resample(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return pcm;
  const ratio = fromRate / toRate;
  const out = new Int16Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const j = Math.floor(pos);
    const a = pcm[j] ?? 0;
    const b = pcm[j + 1] ?? a;
    out[i] = Math.round(a + (b - a) * (pos - j));
  }
  return out;
}

/** Mono 16-bit PCM from a WAV file; multi-channel audio is averaged. */
export function readWav(buf: Buffer): { sampleRate: number; pcm: Int16Array } {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('Not a WAV file');
  }
  let offset = 12;
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    if (id === 'fmt ') {
      channels = buf.readUInt16LE(offset + 10);
      sampleRate = buf.readUInt32LE(offset + 12);
      bits = buf.readUInt16LE(offset + 22);
    } else if (id === 'data') {
      if (bits !== 16) throw new Error(`Only 16-bit WAV is supported (got ${bits}-bit)`);
      // Streamed WAVs may declare a size larger than the file.
      const end = Math.min(buf.length, offset + 8 + size);
      const frames = Math.floor((end - offset - 8) / (2 * channels));
      const pcm = new Int16Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) {
          sum += buf.readInt16LE(offset + 8 + (i * channels + c) * 2);
        }
        pcm[i] = Math.round(sum / channels);
      }
      return { sampleRate, pcm };
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error('WAV file has no audio data');
}

export function encodeWav(pcm: Int16Array, sampleRate = SPEECH_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.byteLength, 40);
  return Buffer.concat([header, pcmToBytes(pcm)]);
}

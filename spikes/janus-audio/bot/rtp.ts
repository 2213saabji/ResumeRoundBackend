/** Plain RTP (RFC 3550) helpers for prototype A. */

export function parseRtp(
  buf: Buffer,
): { payloadType: number; seq: number; payload: Buffer } | null {
  if (buf.length < 12 || buf[0]! >> 6 !== 2) return null;
  const csrcCount = buf[0]! & 0x0f;
  const hasExtension = (buf[0]! & 0x10) !== 0;
  const hasPadding = (buf[0]! & 0x20) !== 0;
  let offset = 12 + csrcCount * 4;
  if (hasExtension) {
    if (buf.length < offset + 4) return null;
    offset += 4 + buf.readUInt16BE(offset + 2) * 4;
  }
  let end = buf.length;
  if (hasPadding) end -= buf[buf.length - 1]!;
  if (offset > end) return null;
  return {
    payloadType: buf[1]! & 0x7f,
    seq: buf.readUInt16BE(2),
    payload: buf.subarray(offset, end),
  };
}

export class RtpWriter {
  private seq = Math.floor(Math.random() * 0xffff);
  private timestamp = Math.floor(Math.random() * 0xffffffff);
  private readonly ssrc = Math.floor(Math.random() * 0xffffffff);

  constructor(private readonly payloadType: number) {}

  /** One RTP packet carrying `samples` worth of audio (960 = 20 ms at 48 kHz). */
  packet(payload: Buffer, samples: number, marker: boolean): Buffer {
    const header = Buffer.alloc(12);
    header[0] = 0x80;
    header[1] = (marker ? 0x80 : 0) | this.payloadType;
    header.writeUInt16BE(this.seq, 2);
    header.writeUInt32BE(this.timestamp >>> 0, 4);
    header.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + samples) >>> 0;
    return Buffer.concat([header, payload]);
  }
}

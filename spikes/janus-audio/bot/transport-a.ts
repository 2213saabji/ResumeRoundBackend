/**
 * Prototype A transport: join the AudioBridge as a plain-RTP participant. Janus sends the room
 * mix minus this participant as RTP/Opus over UDP and mixes what comes back. No ICE/DTLS/SRTP,
 * so this only works on the same host or private network as Janus.
 */
import { createSocket } from 'node:dgram';
import type { JanusWs } from './janus-ws.js';
import { OPUS_PT, attachAudioBridge, env } from './common.js';
import { RtpWriter, parseRtp } from './rtp.js';

export interface AudioLink {
  participantId: number;
  send(opus: Buffer, samples: number, marker: boolean): void;
  onOpus(fn: (payload: Buffer) => void): void;
  close(): Promise<void>;
}

export async function joinPlainRtp(
  janus: JanusWs,
  room: number,
  display: string,
): Promise<AudioLink> {
  const handle = await attachAudioBridge(janus);
  const socket = createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, env.rtpIp, resolve));
  const joined = await handle.message({
    request: 'join',
    room,
    display,
    muted: false,
    rtp: { ip: env.rtpIp, port: socket.address().port, payload_type: OPUS_PT },
  });
  const data = joined.plugindata!.data as { id: number; rtp?: { ip: string; port: number } };
  if (!data.rtp) throw new Error(`No RTP endpoint from Janus: ${JSON.stringify(data)}`);
  const target = data.rtp;
  const writer = new RtpWriter(OPUS_PT);
  let listener: (payload: Buffer) => void = () => {};
  socket.on('message', (buf) => {
    const rtp = parseRtp(buf);
    if (rtp && rtp.payloadType === OPUS_PT) listener(rtp.payload);
  });
  return {
    participantId: data.id,
    send: (opus, samples, marker) =>
      socket.send(writer.packet(opus, samples, marker), target.port, target.ip),
    onOpus: (fn) => {
      listener = fn;
    },
    close: async () => {
      await handle.message({ request: 'leave' }).catch(() => {});
      socket.close();
    },
  };
}

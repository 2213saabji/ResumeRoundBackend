/**
 * Prototype B transport: join the AudioBridge as an ordinary WebRTC peer (werift: ICE, DTLS,
 * SRTP in TypeScript). Same path as a browser, so it works anywhere that can reach Janus.
 */
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from 'werift';
import type { JanusWs } from './janus-ws.js';
import { OPUS_PT, attachAudioBridge } from './common.js';
import type { AudioLink } from './transport-a.js';

export async function joinWebRtc(
  janus: JanusWs,
  room: number,
  display: string,
): Promise<AudioLink> {
  const handle = await attachAudioBridge(janus);
  const pc = new RTCPeerConnection({
    codecs: {
      audio: [
        new RTCRtpCodecParameters({
          mimeType: 'audio/opus',
          clockRate: 48_000,
          channels: 2,
          payloadType: OPUS_PT,
        }),
      ],
      video: [],
    },
  });
  const track = new MediaStreamTrack({ kind: 'audio' });
  pc.addTransceiver(track, { direction: 'sendrecv' });

  let listener: (payload: Buffer) => void = () => {};
  pc.onTrack.subscribe((remote) => remote.onReceiveRtp.subscribe((rtp) => listener(rtp.payload)));
  const connected = new Promise<void>((resolve, reject) => {
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') resolve();
      if (state === 'failed') reject(new Error('WebRTC connection failed'));
    });
  });

  await pc.setLocalDescription(await pc.createOffer());
  while (pc.iceGatheringState !== 'complete') await new Promise((r) => setTimeout(r, 20));
  const joined = await handle.message(
    { request: 'join', room, display, muted: false },
    { type: 'offer', sdp: pc.localDescription!.sdp },
  );
  if (!joined.jsep) throw new Error('Janus sent no answer');
  await pc.setRemoteDescription(joined.jsep);
  await connected;

  let seq = Math.floor(Math.random() * 0xffff);
  let timestamp = Math.floor(Math.random() * 0xffffffff);
  return {
    participantId: (joined.plugindata!.data as { id: number }).id,
    send: (opus, samples, marker) => {
      const header = new RtpHeader({
        payloadType: OPUS_PT,
        sequenceNumber: seq,
        timestamp,
        marker,
      });
      seq = (seq + 1) & 0xffff;
      timestamp = (timestamp + samples) >>> 0;
      track.writeRtp(new RtpPacket(header, opus));
    },
    onOpus: (fn) => {
      listener = fn;
    },
    close: async () => {
      await handle.message({ request: 'leave' }).catch(() => {});
      await pc.close();
    },
  };
}

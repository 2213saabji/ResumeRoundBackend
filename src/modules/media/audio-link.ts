import OpusScript from 'opusscript';
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  RtpHeader,
  RtpPacket,
} from 'werift';
import { FRAME_SAMPLES, SPEECH_SAMPLE_RATE, bytesToPcm, pcmToBytes } from '../speech/audio.js';
import { FramePacer } from './frame-pacer.js';
import type { JanusHandle, JanusWs } from './janus-ws.js';
import { AUDIOBRIDGE_PLUGIN } from './janus-client.js';
import { RtpReorder } from './rtp-reorder.js';

const OPUS_PT = 111;
/** RTP timestamps for Opus always run at 48 kHz, whatever rate we encode at. */
const RTP_TICKS_PER_FRAME = 960;
const CONNECT_TIMEOUT_MS = 15_000;

/** The bot's side of a call: room audio in, interviewer speech out (16 kHz mono PCM). */
export interface AudioLink {
  /** Called with each decoded 20 ms frame the bot hears (the room mix minus its own voice). */
  onAudio(listener: (pcm: Int16Array) => void): void;
  /** Called once if the WebRTC connection fails or closes. */
  onDisconnect(listener: () => void): void;
  /** Plays PCM in real time; resolves when the last frame has been sent. */
  play(pcm: Int16Array): Promise<void>;
  /** Incoming packet counts, for call-quality logs. */
  stats(): { received: number; lost: number };
  close(): Promise<void>;
}

/**
 * Joins an AudioBridge room as an ordinary WebRTC participant (werift: ICE, DTLS and SRTP in
 * TypeScript), the transport the MVP-4 spike chose: it works from any network that can reach
 * Janus, including a developer laptop behind NAT.
 */
export async function joinAudioRoom(
  janus: JanusWs,
  room: {
    roomId: number;
    pin: string;
    display: string;
    /** Packets Janus buffers from this participant before mixing it; room default if unset. */
    prebuffer?: number;
  },
): Promise<AudioLink> {
  const handle: JanusHandle = await janus.attach(AUDIOBRIDGE_PLUGIN);
  const decoder = new OpusScript(SPEECH_SAMPLE_RATE, 1, OpusScript.Application.VOIP);
  const encoder = new OpusScript(SPEECH_SAMPLE_RATE, 1, OpusScript.Application.VOIP);

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

  let audioListener: (pcm: Int16Array) => void = () => {};
  let disconnectListener: () => void = () => {};
  let closed = false;
  // Network jitter can reorder packets; a lost packet becomes 20 ms of silence so the audio
  // timeline (which speech-to-text relies on) stays intact.
  const counts = { received: 0, lost: 0 };
  const reorder = new RtpReorder((payload) => {
    if (!payload) {
      counts.lost++;
      return audioListener(new Int16Array(FRAME_SAMPLES));
    }
    counts.received++;
    try {
      audioListener(bytesToPcm(decoder.decode(payload)));
    } catch {
      audioListener(new Int16Array(FRAME_SAMPLES)); // corrupt packet: treat as lost
    }
  });
  pc.onTrack.subscribe((remote) =>
    remote.onReceiveRtp.subscribe((rtp) => reorder.push(rtp.header.sequenceNumber, rtp.payload)),
  );

  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WebRTC connection timed out')),
      CONNECT_TIMEOUT_MS,
    );
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        clearTimeout(timer);
        resolve();
      }
      if (state === 'failed' || state === 'closed') {
        clearTimeout(timer);
        reject(new Error(`WebRTC connection ${state}`));
        if (!closed) disconnectListener();
      }
    });
  });

  try {
    await pc.setLocalDescription(await pc.createOffer());
    // No trickle: wait for every local candidate, then send one complete offer.
    const gatherDeadline = Date.now() + 5_000;
    while (pc.iceGatheringState !== 'complete' && Date.now() < gatherDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    const joined = await handle.message(
      {
        request: 'join',
        room: room.roomId,
        pin: room.pin,
        display: room.display,
        muted: false,
        ...(room.prebuffer ? { prebuffer: room.prebuffer } : {}),
      },
      { type: 'offer', sdp: pc.localDescription!.sdp },
    );
    if (!joined.jsep) throw new Error('Janus sent no answer to the join offer');
    await pc.setRemoteDescription(joined.jsep);
    await connected;
  } catch (err) {
    closed = true;
    await pc.close().catch(() => {});
    await handle.detach();
    decoder.delete();
    encoder.delete();
    throw err;
  }

  let seq = Math.floor(Math.random() * 0xffff);
  let timestamp = Math.floor(Math.random() * 0xffffffff);
  const pacer = new FramePacer();
  let playing: Promise<void> = Promise.resolve();

  const sendFrame = (frame: Int16Array, marker: boolean) => {
    const opus = encoder.encode(pcmToBytes(frame), FRAME_SAMPLES);
    track.writeRtp(
      new RtpPacket(
        new RtpHeader({ payloadType: OPUS_PT, sequenceNumber: seq, timestamp, marker }),
        opus,
      ),
    );
    seq = (seq + 1) & 0xffff;
    timestamp = (timestamp + RTP_TICKS_PER_FRAME) >>> 0;
  };

  const playNow = async (pcm: Int16Array) => {
    // After a pause (or the first time) the RTP marker flags a new talkspurt.
    const resumed = pacer.start();
    for (let offset = 0; offset < pcm.length && !closed; offset += FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      frame.set(pcm.subarray(offset, offset + FRAME_SAMPLES));
      sendFrame(frame, resumed && offset === 0);
      await pacer.frameSent();
    }
  };

  return {
    onAudio: (listener) => {
      audioListener = listener;
    },
    stats: () => ({ ...counts }),
    onDisconnect: (listener) => {
      disconnectListener = listener;
    },
    play: (pcm) => {
      // Chunks play strictly in order, even if the caller does not await each one.
      playing = playing.then(() => playNow(pcm));
      return playing;
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await handle.message({ request: 'leave' }).catch(() => {});
      await handle.detach();
      await pc.close().catch(() => {});
      decoder.delete();
      encoder.delete();
    },
  };
}

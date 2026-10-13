import { SPEECH_SAMPLE_RATE } from '../audio.js';
import type {
  SpeechToText,
  SttHandlers,
  SttStream,
  SttStreamOptions,
  SynthesisOptions,
  TextToSpeech,
} from '../types.js';

/**
 * No-key STT for local development and tests. It cannot understand audio: each `finalize()`
 * (the speech gate calls it when the speaker pauses) ends an utterance whose text says how much
 * audio arrived.
 */
export class MockStt implements SpeechToText {
  readonly provider = 'mock';

  async openStream(_opts: SttStreamOptions, handlers: SttHandlers): Promise<SttStream> {
    let pendingSamples = 0;
    let closed = false;
    const stream = {
      audioSeconds: 0,
      write(pcm: Int16Array) {
        if (closed || pcm.length === 0) return;
        if (pendingSamples === 0) handlers.onSpeechStarted?.();
        pendingSamples += pcm.length;
        stream.audioSeconds += pcm.length / SPEECH_SAMPLE_RATE;
      },
      async finalize() {
        if (pendingSamples === 0) return;
        const text = `(mock transcript of ${(pendingSamples / SPEECH_SAMPLE_RATE).toFixed(1)} s of audio)`;
        pendingSamples = 0;
        handlers.onFinal?.(text);
        handlers.onUtteranceEnd?.(text);
        handlers.onWordGap?.();
      },
      async close() {
        if (closed) return;
        await stream.finalize();
        closed = true;
        handlers.onClose?.();
      },
    };
    return stream;
  }
}

/** Speaking pace used to size the mock audio: about 15 characters per second. */
const MOCK_MS_PER_CHAR = 65;

/** No-key TTS: silence as long as the text would take to say. */
export class MockTts implements TextToSpeech {
  readonly provider = 'mock';
  readonly voiceId = 'mock';

  async *stream(text: string, _opts: SynthesisOptions): AsyncGenerator<Int16Array> {
    const samples = Math.round((text.trim().length * MOCK_MS_PER_CHAR * SPEECH_SAMPLE_RATE) / 1000);
    if (samples > 0) yield new Int16Array(samples);
  }
}

import { DEFAULT_TTS_VOICE, config } from '../../common/config.js';
import { getStorage } from '../../common/storage/index.js';
import { DeepgramTts } from './providers/deepgram-tts.js';
import { DeepgramStt } from './providers/deepgram.js';
import { GoogleTts } from './providers/google-tts.js';
import { MockStt, MockTts } from './providers/mock.js';
import { CachedTts } from './tts-cache.js';
import type { SpeechToText, TextToSpeech } from './types.js';

let stt: SpeechToText | undefined;
let tts: TextToSpeech | undefined;

/** Speech-to-text, chosen by STT_PROVIDER. */
export function getSpeechToText(): SpeechToText {
  stt ??=
    config.STT_PROVIDER === 'deepgram'
      ? new DeepgramStt({
          apiKey: config.DEEPGRAM_API_KEY!,
          model: config.STT_MODEL,
          language: config.STT_LANGUAGE,
          endpointingMs: config.STT_ENDPOINTING_MS,
          utteranceEndMs: config.STT_UTTERANCE_END_MS,
        })
      : new MockStt();
  return stt;
}

function createTts(): TextToSpeech {
  switch (config.TTS_PROVIDER) {
    case 'deepgram':
      return new DeepgramTts({
        apiKey: config.DEEPGRAM_API_KEY!,
        voice: config.TTS_VOICE ?? DEFAULT_TTS_VOICE.deepgram,
      });
    case 'google':
      return new GoogleTts({
        apiKey: config.GOOGLE_TTS_API_KEY!,
        voice: config.TTS_VOICE ?? DEFAULT_TTS_VOICE.google,
        speakingRate: config.TTS_SPEAKING_RATE,
      });
    default:
      return new MockTts();
  }
}

/** Text-to-speech, chosen by TTS_PROVIDER, with the phrase cache in front. */
export function getTextToSpeech(): TextToSpeech {
  tts ??= new CachedTts(createTts(), getStorage());
  return tts;
}

/** Test hooks: swap the providers. */
export function setSpeechToText(provider: SpeechToText): void {
  stt = provider;
}

export function setTextToSpeech(provider: TextToSpeech): void {
  tts = provider;
}

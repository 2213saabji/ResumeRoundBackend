import { AppError } from '../../common/errors.js';
import type { Logger } from '../../common/logger.js';
import { findCurrentTurn, interviewLoop } from '../interviews/loop.js';
import type { Interview } from '../interviews/model.js';
import { interviewsRepository } from '../interviews/repository.js';
import { rmsDbfs } from '../speech/audio.js';
import { GatedSttStream } from '../speech/speech-gate.js';
import { SentenceChunker, speakSentences, synthesizeAll } from '../speech/streaming-tts.js';
import type { SpeechToText, SttStream, TextToSpeech } from '../speech/types.js';
import { AnswerCollector, type AnswerCollectorOptions } from './answer-collector.js';
import { joinAudioRoom, type AudioLink } from './audio-link.js';
import type { JanusClient } from './janus-client.js';
import { TEXTROOM_PLUGIN } from './janus-client.js';
import type { JanusHandle, JanusWs } from './janus-ws.js';

export type CallState = 'starting' | 'speaking' | 'listening' | 'thinking' | 'ended';

/** Caption-room events (docs/FRONTEND_INTEGRATION.md 7.6), sent as TextRoom announcements. */
export type CallEvent =
  | { type: 'state'; state: 'speaking' | 'listening' | 'thinking' }
  | { type: 'interviewer'; seq: number; text: string }
  | { type: 'candidate'; seq: number; text: string; final: boolean }
  | { type: 'ended'; reason: 'completed' | 'time_up' | 'ended_by_user' };

export interface CallDeps {
  janus: JanusWs;
  rooms: Pick<JanusClient, 'destroyAudioRoom' | 'destroyTextRoom'>;
  stt: SpeechToText;
  tts: TextToSpeech;
  log: Logger;
  collector?: Partial<AnswerCollectorOptions>;
  /** How often the call re-reads the interview (typed answers, End button, time). */
  pollMs: number;
  /** Janus jitter buffer for the bot's voice, in 20 ms packets (room default if unset). */
  prebuffer?: number;
}

/** Longest answer the interview loop accepts (same limit as typed answers). */
const MAX_ANSWER_CHARS = 5_000;
const SUBMIT_ATTEMPTS = 3;
/**
 * Said right after an answer, while the next question is prepared (as a person would), so
 * the candidate is not left in silence. Fixed phrases: synthesised once, then cached.
 */
const ACKNOWLEDGEMENTS = ['Okay.', 'Got it.', 'Alright.', 'Thanks.', 'I see.', 'Okay, thanks.'];
/** Said once if the next question takes longer than SLOW_AI_MS (a slow or busy model). */
const STILL_THINKING = 'Give me a moment.';
const SLOW_AI_MS = 7_000;

/**
 * The answer only counts as finished after this much real silence in the audio, whatever the
 * recogniser says: on a lossy network it can miss words for a second and report a pause
 * while the candidate is still talking.
 */
const MIN_TRAILING_SILENCE_MS = 700;
/** Gives up waiting for silence after this long (constant background noise). */
const MAX_SILENCE_WAIT_MS = 15_000;
/** Frames louder than this count as the candidate speaking (same threshold as the gate). */
const VOICE_DBFS = -45;

const SORRY =
  'Sorry, I had a problem on my side and missed that. Could you give me that answer again?';

function endReason(i: Interview): Extract<CallEvent, { type: 'ended' }>['reason'] {
  if (i.endReason === 'timeout') return 'time_up';
  if (i.endReason === 'user_ended') return 'ended_by_user';
  return 'completed';
}

/** Backend jargon that general speech models often mishear ("item potent" for idempotent). */
const BASE_KEYTERMS = [
  'idempotency',
  'idempotent',
  'Kubernetes',
  'PostgreSQL',
  'MongoDB',
  'Redis',
  'Kafka',
  'RabbitMQ',
  'microservices',
  'sharding',
  'p99',
  'latency',
  'throughput',
  'cache invalidation',
  'load balancer',
  'CI/CD',
];

/** Words the recogniser should expect: the plan's technologies and projects, then jargon. */
function keytermsOf(i: Interview): string[] {
  const terms = [
    ...i.plan.flatMap((o) => [...o.technologies, o.projectName ?? '']),
    ...BASE_KEYTERMS,
  ];
  return [...new Set(terms.map((t) => t.trim()).filter(Boolean))];
}

/** Fixes common recogniser splits of technology names ("Node. Js" -> "Node.js"). */
export function tidyTranscript(text: string): string {
  return text.replace(/\b(Node|Next|Nest|Vue|Nuxt|Express|Three|D3)\.\s?[Jj][Ss]\b/g, '$1.js');
}

const isStatus = (err: unknown, status: number) => err instanceof AppError && err.status === status;

/**
 * One live voice interview, run by the bot: joins the call, speaks each question, listens to
 * the answer, hands it to the same interview loop typed answers use, and speaks what comes
 * next, until the interview ends. Half duplex for now: the candidate's audio is ignored while
 * the interviewer speaks or thinks (barge-in comes later).
 */
export class InterviewCall {
  state: CallState = 'starting';
  private audio?: AudioLink;
  private captions?: JanusHandle;
  private stt?: SttStream;
  private poller?: NodeJS.Timeout;
  private room!: { roomId: number; secret: string; pin: string };
  /** The question being answered now. */
  private seq = 0;
  /** When the candidate's audio was last above the voice threshold. */
  private lastVoicedAt = 0;
  private finishing = false;
  /** Resolves once the latest acknowledgement is queued for playback. */
  private fillerQueued: Promise<void> = Promise.resolve();
  /** Turn timing for latency tuning (debug logs): when the last answer ended, per step. */
  private marks: Record<string, number> = {};
  private readonly collector: AnswerCollector;
  private finished!: () => void;
  private readonly done = new Promise<void>((resolve) => (this.finished = resolve));

  constructor(
    private readonly deps: CallDeps,
    private readonly interviewId: string,
  ) {
    this.collector = new AnswerCollector(
      (text) => this.announce({ type: 'candidate', seq: this.seq, text, final: false }),
      () => void this.finishAnswer(),
      deps.collector,
    );
  }

  /** Runs the call; resolves when it has ended (interview over, or the connection was lost). */
  async run(): Promise<void> {
    const interview = await interviewsRepository.findById(this.interviewId);
    const j = interview?.janus;
    if (!interview || interview.status !== 'in_progress' || !j?.roomId || !j.roomSecret) return;
    if (!j.roomPin) return;
    this.room = { roomId: j.roomId, secret: j.roomSecret, pin: j.roomPin };
    const log = this.deps.log;

    try {
      this.captions = await this.deps.janus.attach(TEXTROOM_PLUGIN);
      this.audio = await joinAudioRoom(this.deps.janus, {
        ...this.room,
        display: 'interviewer',
        prebuffer: this.deps.prebuffer,
      });
      this.audio.onDisconnect(() => {
        log.warn('call audio disconnected');
        void this.stop();
      });
      this.stt = new GatedSttStream(
        await this.deps.stt.openStream(
          {
            keyterms: keytermsOf(interview),
            ctx: { userId: interview.userId.toString(), interviewId: this.interviewId },
          },
          {
            onPartial: (t) => this.state === 'listening' && this.collector.partialResult(t),
            onFinal: (t) => this.state === 'listening' && this.collector.finalResult(t),
            onWordGap: () => {
              if (this.state !== 'listening') return;
              this.marks = { utteranceEnd: performance.now() };
              this.collector.utteranceEnded();
            },
            onSpeechStarted: () => this.collector.speechStarted(),
            onError: (err) => {
              log.error({ err }, 'speech-to-text stream failed');
              void this.stop();
            },
          },
        ),
      );
      this.audio.onAudio((pcm) => {
        if (this.state !== 'listening') return;
        if (rmsDbfs(pcm) > VOICE_DBFS) this.lastVoicedAt = performance.now();
        this.stt?.write(pcm);
      });
    } catch (err) {
      log.error({ err }, 'could not join the call');
      await this.stop();
      return this.done;
    }

    log.info({ roomId: this.room.roomId }, 'interviewer joined the call');
    // Warm the phrase cache in the background so the first acknowledgement is instant too.
    for (const phrase of [...ACKNOWLEDGEMENTS, STILL_THINKING]) {
      void this.sayCached(phrase, false).catch(() => {});
    }
    this.poller = setInterval(() => void this.poll(), this.deps.pollMs);
    const turn = await findCurrentTurn(interview);
    if (turn) await this.speak(turn.seq, turn.questionText);
    else this.setListening(interview.state.questionsAsked);
    return this.done;
  }

  /** Leaves the call without ending the interview (the bot restarts it on the next poll). */
  async stop(): Promise<void> {
    if (this.state === 'ended') return;
    this.state = 'ended';
    clearInterval(this.poller);
    this.collector.reset();
    if (this.audio) this.deps.log.info({ audioIn: this.audio.stats() }, 'call audio stats');
    await this.stt?.close().catch(() => {});
    await this.audio?.close().catch(() => {});
    await this.captions?.detach().catch(() => {});
    this.finished();
  }

  /** The interview is over: say goodbye in captions, leave, and remove the rooms. */
  private async finish(interview: Interview): Promise<void> {
    if (this.state === 'ended') return;
    this.announce({ type: 'ended', reason: endReason(interview) });
    await new Promise((r) => setTimeout(r, 500)); // let the event reach Janus before leaving
    await this.stop();
    await this.deps.rooms.destroyAudioRoom(this.room.roomId, this.room.secret).catch(() => {});
    await this.deps.rooms.destroyTextRoom(this.room.roomId, this.room.secret).catch(() => {});
    this.deps.log.info({ reason: interview.endReason }, 'interview call finished');
  }

  /**
   * Sends a caption event without waiting for Janus to confirm it: messages on the one
   * WebSocket arrive in order, and a round trip per caption would delay the voice.
   */
  private announce(event: CallEvent): void {
    if (!this.captions) return;
    void this.captions
      .message({
        request: 'announcement',
        room: this.room.roomId,
        secret: this.room.secret,
        text: JSON.stringify(event),
      })
      .catch((err: unknown) => this.deps.log.warn({ err }, 'caption announcement failed'));
  }

  private setListening(seq: number): void {
    this.seq = seq;
    this.collector.reset();
    this.state = 'listening';
    this.announce({ type: 'state', state: 'listening' });
  }

  /** Speaks `text` sentence by sentence (captions in step with the voice), then listens. */
  private async speak(seq: number, text: string, opts: { cache?: boolean } = {}): Promise<void> {
    if (this.state === 'ended') return;
    this.state = 'speaking';
    this.announce({ type: 'state', state: 'speaking' });
    const chunker = new SentenceChunker();
    const sentences = [...chunker.push(text), chunker.flush()].filter((s): s is string => !!s);
    // An acknowledgement still being synthesised goes first (bounded: never hold the question).
    const filler = Promise.race([this.fillerQueued, new Promise((r) => setTimeout(r, 1_500))]);
    try {
      for await (const chunk of speakSentences(this.deps.tts, sentences, {
        ctx: { interviewId: this.interviewId },
        cache: opts.cache,
      })) {
        if (this.state !== 'speaking') return;
        if (chunk.first) {
          await filler;
          this.announce({ type: 'interviewer', seq, text: chunk.text });
        }
        if (this.marks.answered && !this.marks.firstAudio) {
          this.marks.firstAudio = performance.now();
          this.logTurnTiming();
        }
        await this.audio?.play(chunk.pcm);
      }
    } catch (err) {
      // The candidate can still read the question in the captions.
      this.deps.log.error({ err }, 'text-to-speech failed; question shown as caption only');
      this.announce({ type: 'interviewer', seq, text });
    }
    if (this.state === 'speaking') this.setListening(seq);
  }

  private logTurnTiming(): void {
    const m = this.marks;
    const since = (a?: number, b?: number) => (a && b ? Math.round(b - a) : undefined);
    this.deps.log.debug(
      {
        graceMs: since(m.utteranceEnd, m.submitted),
        aiMs: since(m.submitted, m.answered),
        ttsFirstAudioMs: since(m.answered, m.firstAudio),
        totalSinceUtteranceEndMs: since(m.utteranceEnd, m.firstAudio),
      },
      'turn timing',
    );
  }

  /** The candidate paused long enough: collect the recogniser's last words, then submit. */
  private async finishAnswer(): Promise<void> {
    if (this.state !== 'listening' || this.finishing) return;
    this.finishing = true;
    try {
      const deadline = performance.now() + MAX_SILENCE_WAIT_MS;
      while (
        performance.now() - this.lastVoicedAt < MIN_TRAILING_SILENCE_MS &&
        performance.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 50));
        if (this.state !== 'listening') return;
      }
      // The recogniser lags the audio by a few hundred ms: flush it so the last words count.
      await this.stt?.finalize();
      if (this.state !== 'listening') return;
      const answer = tidyTranscript(this.collector.text);
      this.collector.reset();
      if (answer) await this.submit(answer);
    } finally {
      this.finishing = false;
    }
  }

  private async submit(answer: string): Promise<void> {
    if (this.state !== 'listening') return;
    this.marks.submitted = performance.now();
    const seq = this.seq;
    this.state = 'thinking';
    this.announce({ type: 'candidate', seq, text: answer, final: true });
    this.announce({ type: 'state', state: 'thinking' });
    const ack = ACKNOWLEDGEMENTS[Math.floor(Math.random() * ACKNOWLEDGEMENTS.length)]!;
    void this.sayCached(ack).catch(() => {});
    const slow = setTimeout(() => {
      if (this.state === 'thinking') void this.sayCached(STILL_THINKING).catch(() => {});
    }, SLOW_AI_MS);

    try {
      await this.process(seq, answer);
    } finally {
      clearTimeout(slow);
    }
  }

  /**
   * Plays a short fixed phrase from the phrase cache (no caption). `play: false` only warms the
   * cache. The next question waits until the phrase is queued, so they never swap order.
   */
  private sayCached(phrase: string, play = true): Promise<void> {
    const synth = synthesizeAll(this.deps.tts, phrase, {
      ctx: { interviewId: this.interviewId },
      cache: true,
    });
    if (!play) return synth.then(() => {});
    let queued!: () => void;
    this.fillerQueued = new Promise((resolve) => (queued = resolve));
    return synth
      .then((pcm) => {
        const playing = this.state !== 'ended' ? this.audio?.play(pcm) : undefined;
        queued();
        return playing;
      })
      .finally(() => queued());
  }

  private async process(seq: number, answer: string): Promise<void> {
    for (let attempt = 1; attempt <= SUBMIT_ATTEMPTS; attempt++) {
      try {
        const current = await interviewsRepository.findById(this.interviewId);
        if (!current) return this.stop();
        const { interview, closingMessage } = await interviewLoop.submitAnswer(
          current,
          seq,
          answer.slice(0, MAX_ANSWER_CHARS),
        );
        if (this.state !== 'thinking') return; // ended (End button) while scoring
        this.marks.answered = performance.now();
        if (interview.status !== 'in_progress') {
          if (closingMessage) await this.speak(seq, closingMessage, { cache: true });
          return this.finish(interview);
        }
        const next = await findCurrentTurn(interview);
        if (next) return this.speak(next.seq, next.questionText);
        return this.setListening(interview.state.questionsAsked);
      } catch (err) {
        if (isStatus(err, 409)) return this.resync();
        this.deps.log.warn({ err, attempt }, 'submitting the spoken answer failed');
        if (!isStatus(err, 503) || attempt === SUBMIT_ATTEMPTS) break;
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
      }
    }
    await this.speak(seq, SORRY, { cache: true });
  }

  /** Someone else moved the interview on (a typed answer, the End button): catch up. */
  private async resync(): Promise<void> {
    const interview = await interviewsRepository.findById(this.interviewId);
    if (!interview) return this.stop();
    if (interview.status !== 'in_progress') return this.finish(interview);
    const turn = await findCurrentTurn(interview);
    if (turn && turn.seq !== this.seq) return this.speak(turn.seq, turn.questionText);
    if (this.state === 'thinking') this.setListening(this.seq);
  }

  private async poll(): Promise<void> {
    if (this.state === 'ended' || this.state === 'thinking') return;
    try {
      const interview = await interviewsRepository.findById(this.interviewId);
      if (!interview) return void (await this.stop());
      if (interview.status !== 'in_progress') return void (await this.finish(interview));
      if (this.state === 'listening' && interview.state.questionsAsked !== this.seq) {
        await this.resync();
      }
    } catch (err) {
      this.deps.log.warn({ err }, 'call poll failed');
    }
  }
}

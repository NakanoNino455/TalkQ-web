import type { SpeechErrorInfo, SpeechStatus } from "@/types";
import { mergeTranscripts } from "./dsp";

/**
 * Restart policy — these numbers are the heart of the far-field fix.
 *
 * The previous version waited a fixed 350 ms before every automatic restart
 * (a 350 ms hole in the audio each time Chrome ended the session) and treated
 * "12 restarts in a minute" as a fatal failure, which a normal quiet room
 * reaches easily — that is why live translation kept switching itself off.
 */
const RESTART_WINDOW_MS = 60_000;
/** Restarts inside that window before we back off (never a fatal stop). */
const RESTART_SOFT_LIMIT = 20;
/** Backoff ladder, used only after errors; a normal end restarts immediately. */
const RESTART_BACKOFF_MS = [0, 60, 200, 500, 1000, 2000];
/**
 * audio-capture (the recognizer cannot open the input) is retried this many
 * times, with the backoff ladder above stretching each attempt out to ~2-5 s.
 * Measured on the live site: 4 attempts inside a second gave up long before a
 * device that was merely busy could recover.
 */
const RECOVERABLE_CAPTURE_RETRIES = 8;
/**
 * How long Chrome needs to release the microphone after a session ends.
 * Starting a new session inside this window either throws
 * "recognition has already started" or yields a session that never fires
 * onstart — reported as "stop, start again, nothing happens".
 */
const SESSION_RELEASE_GRACE_MS = 300;

/**
 * Web Speech API wrapper (Chrome / Edge).
 *
 * DeepSeek has no audio endpoint, so speech becomes text here, in the browser,
 * and only the text is sent to DeepSeek for translation.
 *
 * Chrome's recognizer stops itself after a pause, so this class keeps the
 * session alive by restarting it while `running` is true, with backoff and a
 * restart budget so a broken recognizer cannot spin forever.
 *
 * Privacy note: Chrome implements this by streaming microphone audio to
 * Google's speech service. Nothing in this file touches DeepSeek.
 */

/* ── Minimal structural types (the DOM lib does not ship these) ──────── */

interface SpeechAlternativeLike {
  transcript: string;
  confidence: number;
}

interface SpeechResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternativeLike;
}

interface SpeechResultListLike {
  length: number;
  [index: number]: SpeechResultLike;
}

export interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: SpeechResultListLike;
}

export interface SpeechRecognitionErrorLike {
  error: string;
  message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorLike) => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onnomatch: (() => void) | null;
  onaudiostart: (() => void) | null;
  onaudioend: (() => void) | null;
}

type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

interface SpeechWindow {
  SpeechRecognition?: SpeechRecognitionCtor;
  webkitSpeechRecognition?: SpeechRecognitionCtor;
}

/* ── Capability detection ────────────────────────────────────────────── */

export function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as SpeechWindow;
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isSpeechRecognitionSupported(): boolean {
  return getSpeechRecognitionCtor() !== null;
}

/** `getUserMedia` needs a secure context: https or localhost. */
export function isSecureForMicrophone(): boolean {
  if (typeof window === "undefined") return false;
  if (window.isSecureContext) return true;
  const host = window.location.hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** Human-readable reason why live translation cannot run here. */
export function describeEnvironmentProblem(): { title: string; detail: string } | null {
  if (!isSpeechRecognitionSupported()) {
    return {
      title: "This browser has no speech recognition",
      detail:
        "The Web Speech API is only implemented by Chrome and Edge. Open this page in Chrome/Edge on desktop, or Android Chrome.",
    };
  }
  if (!isSecureForMicrophone()) {
    return {
      title: "Microphone needs HTTPS",
      detail:
        "Browsers only expose the microphone on https:// or localhost. Use the deployed https:// page instead of a local file.",
    };
  }
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
    return {
      title: "Microphone API unavailable",
      detail: "navigator.mediaDevices.getUserMedia is missing in this context.",
    };
  }
  return null;
}

/* ── Error taxonomy ──────────────────────────────────────────────────── */

export function describeSpeechError(code: string, message?: string): SpeechErrorInfo {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return {
        code,
        title: "Microphone permission denied",
        detail: message || "The browser blocked microphone access for this site.",
        hint: "Click the padlock/microphone icon in the address bar → Allow, then start again.",
        fatal: true,
      };
    case "audio-capture":
      return {
        code,
        title: "No microphone found",
        detail: message || "Chrome could not open an audio input device.",
        hint:
          "设备被别的程序占用或已断开。远场场景建议用外接麦克风；如果是 USB 麦克风，换个接口或重新插拔。",
        // Retried a few times before giving up (see RECOVERABLE_CAPTURE_RETRIES).
        fatal: false,
      };
    case "network":
      return {
        code,
        title: "Speech service unreachable",
        detail:
          message ||
          "Chrome's built-in recognizer sends audio to Google's speech service, and that request failed.",
        hint:
          "网络抖动会自己恢复；如果一直失败，请检查代理/VPN —— 内置识别必须能访问 Google 的语音服务。",
        // Recoverable: a blip must not end the session (it used to).
        fatal: false,
      };
    case "language-not-supported":
      return {
        code,
        title: "Recognition language unsupported",
        detail: message || "Chrome does not support this recognition language.",
        hint: "Pick 中文（普通话）or English (US) in the language selector.",
        fatal: true,
      };
    case "no-speech":
      return {
        code,
        title: "No speech detected",
        detail: "The recognizer heard silence and stopped.",
        hint: "Check the input device and speak closer to the microphone.",
        fatal: false,
      };
    case "aborted":
      return { code, title: "Recognition aborted", fatal: false };
    default:
      return {
        code,
        title: "Speech recognition error",
        detail: message || code,
        fatal: false,
      };
  }
}

/* ── The recognizer ──────────────────────────────────────────────────── */

export interface LiveRecognizerHandlers {
  /** Unstable text — replaced as the user keeps talking. */
  onInterim: (text: string) => void;
  /** A finished utterance. */
  onFinal: (text: string) => void;
  onStatus: (status: SpeechStatus) => void;
  onError: (error: SpeechErrorInfo) => void;
  onSpeechStart?: () => void;
  /** Fired when a session ends and is restarted, with the reason. */
  onRestart?: (info: { count: number; reason: RestartReason; gapMs: number }) => void;
  /** True while the VAD says a voice is present (drives restart eagerness). */
  isSpeechActive?: () => boolean;
}

export type RestartReason = "ended" | "no-speech" | "network" | "aborted" | "audio-capture" | "unknown";

export interface RecognizerDiagnostics {
  state: SpeechStatus;
  running: boolean;
  language: string;
  restartCount: number;
  /** Restarts in the current session, with the reason that triggered them. */
  restartsByReason: Record<RestartReason, number>;
  lastError: SpeechErrorInfo | null;
  lastErrorAt: number | null;
  lastPartial: string;
  lastFinal: string;
  /** Text recognised but not yet committed (carried across restarts). */
  pending: string;
  sessionStartedAt: number | null;
  lastEventAt: number | null;
  lastEvent: string;
  /** Milliseconds the recognizer was NOT listening because of a restart. */
  lastGapMs: number;
  totalGapMs: number;
  /** Sessions that ended without producing any final result. */
  emptySessions: number;
  finalsCount: number;
}

/**
 * Wrapper around Chrome's SpeechRecognition built for far-field listening.
 *
 * The three things that decide whether a distant speaker keeps their words:
 *
 * 1. Restart immediately. Chrome ends the session on silence; the old code
 *    waited a fixed 350 ms, which is a 350 ms hole in the audio. A normal end
 *    now restarts on the next tick; only repeated *errors* back off.
 * 2. Never stop the session because of transient errors. no-speech, network,
 *    aborted and briefly missing audio are recoverable; the session used to
 *    shut itself off after 12 restarts in a minute, which a quiet room reaches
 *    easily.
 * 3. Keep the unfinished sentence. Interim text that had not been committed
 *    when the session ended is carried over and merged into the next final, so
 *    a restart mid-sentence no longer drops the tail.
 */
export class LiveRecognizer {
  private recognition: SpeechRecognitionLike | null = null;
  private handlers: LiveRecognizerHandlers;
  private running = false;
  private restartTimes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private language: string;
  private pendingInterim = "";
  /**
   * Which session produced `pendingInterim`. A final that belongs to the SAME
   * session supersedes its interim (Chrome revises the text), so merging there
   * would duplicate the sentence; only text left over from an earlier session
   * may be merged into a new final.
   */
  private pendingSession = 0;
  private sessionSeq = 0;
  private consecutiveErrors = 0;
  private captureRetries = 0;
  private lastRestartAt: number | null = null;
  /** When the last session ended (used to avoid restarting too early). */
  private lastEndedAt = 0;
  private diagnostics: RecognizerDiagnostics;

  constructor(handlers: LiveRecognizerHandlers, language: string) {
    this.handlers = handlers;
    this.language = language;
    this.diagnostics = {
      state: "idle",
      running: false,
      language,
      restartCount: 0,
      restartsByReason: { ended: 0, "no-speech": 0, network: 0, aborted: 0, "audio-capture": 0, unknown: 0 },
      lastError: null,
      lastErrorAt: null,
      lastPartial: "",
      lastFinal: "",
      pending: "",
      sessionStartedAt: null,
      lastEventAt: null,
      lastEvent: "",
      lastGapMs: 0,
      totalGapMs: 0,
      emptySessions: 0,
      finalsCount: 0,
    };
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentLanguage(): string {
    return this.language;
  }

  getDiagnostics(): RecognizerDiagnostics {
    return { ...this.diagnostics, pending: this.pendingInterim };
  }

  /** Text recognised but not yet committed — flushed on stop. */
  get pendingText(): string {
    return this.pendingInterim;
  }

  start(language?: string): void {
    if (language) this.language = language;
    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      this.handlers.onError(describeSpeechError("not-supported"));
      return;
    }

    this.running = true;
    this.restartTimes = [];
    this.pendingInterim = "";
    this.pendingSession = 0;
    this.sessionSeq = 0;
    this.consecutiveErrors = 0;
    this.captureRetries = 0;
    this.diagnostics.running = true;
    this.diagnostics.language = this.language;
    this.diagnostics.sessionStartedAt = Date.now();
    this.diagnostics.lastGapMs = 0;
    this.diagnostics.totalGapMs = 0;
    this.handlers.onStatus("starting");
    this.mark("start");

    /**
     * Chrome releases the microphone asynchronously after a session ends. Starting
     * a new session inside that window throws ("recognition has already started")
     * or produces a session that never fires onstart — reported as "stop then
     * start again and nothing happens". Wait out the release instead of racing it.
     */
    const sinceEnd = this.lastEndedAt ? Date.now() - this.lastEndedAt : Number.POSITIVE_INFINITY;
    const grace = sinceEnd < SESSION_RELEASE_GRACE_MS ? SESSION_RELEASE_GRACE_MS - sinceEnd : 0;
    if (grace > 0) {
      this.restartTimer = setTimeout(() => {
        this.restartTimer = undefined;
        if (this.running) this.spawn(Ctor);
      }, grace);
      return;
    }
    this.spawn(Ctor);
  }

  stop(): void {
    this.running = false;
    this.lastEndedAt = Date.now();
    this.diagnostics.running = false;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;

    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onend = null;
      recognition.onerror = null;
      recognition.onresult = null;
      try {
        recognition.stop();
      } catch {
        /* already stopped */
      }
    }

    // Commit whatever was still in flight so the sentence is not lost.
    this.flushPending();
    this.handlers.onStatus("idle");
    this.diagnostics.state = "idle";
    this.mark("stop");
  }

  /** Switch recognition language without dropping the session. */
  setLanguage(language: string): void {
    if (language === this.language) return;
    this.language = language;
    this.diagnostics.language = language;
    if (!this.running) return;
    this.flushPending();
    const recognition = this.recognition;
    this.recognition = null;
    if (recognition) {
      recognition.onend = null;
      try {
        recognition.abort();
      } catch {
        /* ignore */
      }
    }
    this.spawn(getSpeechRecognitionCtor()!);
  }

  private mark(event: string): void {
    this.diagnostics.lastEvent = event;
    this.diagnostics.lastEventAt = Date.now();
  }

  /** Emit carried-over text as a final result (used on stop / language switch). */
  private flushPending(): void {
    const text = this.pendingInterim.trim();
    this.pendingInterim = "";
    this.pendingSession = 0;
    this.diagnostics.pending = "";
    if (!text) return;
    this.diagnostics.finalsCount += 1;
    this.diagnostics.lastFinal = text;
    this.handlers.onFinal(text);
  }

  private spawn(Ctor: SpeechRecognitionCtor): void {
    if (!this.running) return;

    this.sessionSeq += 1;
    const sessionId = this.sessionSeq;
    const recognition = new Ctor();
    recognition.lang = this.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    let producedFinal = false;
    let producedAnything = false;

    recognition.onstart = () => {
      if (!this.running) return;
      this.handlers.onStatus("listening");
      this.diagnostics.state = "listening";
      this.diagnostics.sessionStartedAt = Date.now();
      // Measure how long we were deaf between sessions.
      if (this.lastRestartAt) {
        const gap = Date.now() - this.lastRestartAt;
        this.diagnostics.lastGapMs = gap;
        this.diagnostics.totalGapMs += gap;
      }
      this.mark("onstart");
    };

    recognition.onaudiostart = () => this.mark("onaudiostart");
    recognition.onaudioend = () => this.mark("onaudioend");

    recognition.onspeechstart = () => {
      if (!this.running) return;
      this.mark("onspeechstart");
      this.handlers.onSpeechStart?.();
    };

    recognition.onspeechend = () => this.mark("onspeechend");

    recognition.onnomatch = () => this.mark("onnomatch");

    recognition.onresult = (event) => {
      if (!this.running) return;
      producedAnything = true;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const cleaned = transcript.trim();
          if (cleaned) {
            // A final from THIS session supersedes its own interim (Chrome
            // revises the text), so it is used as-is. Only text stranded by an
            // earlier session is merged in — that is the word-loss fix.
            const carried = this.pendingSession < sessionId ? this.pendingInterim : "";
            const merged = mergeRecognitionText(carried, cleaned);
            this.pendingInterim = "";
            this.pendingSession = 0;
            this.diagnostics.pending = "";
            producedFinal = true;
            this.diagnostics.finalsCount += 1;
            this.diagnostics.lastFinal = merged;
            this.mark("onfinal");
            this.handlers.onFinal(merged);
          }
        } else {
          interim += transcript;
        }
      }
      const trimmed = interim.trim();
      if (trimmed) {
        this.pendingInterim = trimmed;
        this.pendingSession = sessionId;
        this.diagnostics.lastPartial = trimmed;
        this.diagnostics.pending = trimmed;
      }
      // Show the whole sentence while speaking: text carried over from the
      // previous session plus what this session hears so far.
      const carried = this.pendingSession < sessionId ? this.pendingInterim : "";
      this.handlers.onInterim(carried ? mergeRecognitionText(carried, trimmed) : trimmed);
    };

    recognition.onerror = (event) => {
      const info = describeSpeechError(event.error, event.message);
      if (info.code === "aborted" && !this.running) return;
      this.diagnostics.lastError = info;
      this.diagnostics.lastErrorAt = Date.now();
      this.mark(`onerror:${info.code}`);

      const recoverable = !info.fatal;
      if (recoverable) {
        this.consecutiveErrors += 1;
        this.bumpReason(reasonForError(info.code));
      }

      // audio-capture (device busy/unplugged) gets a few chances, then stops.
      if (info.code === "audio-capture") {
        this.captureRetries += 1;
        if (this.captureRetries > RECOVERABLE_CAPTURE_RETRIES) {
          this.running = false;
          this.diagnostics.running = false;
          this.handlers.onError({
            ...info,
            title: "麦克风不可用",
            detail: `${info.detail ?? ""}（已重试 ${RECOVERABLE_CAPTURE_RETRIES} 次）`.trim(),
            fatal: true,
          });
          this.handlers.onStatus("error");
          this.diagnostics.state = "error";
          return;
        }
      }

      if (info.fatal) {
        this.running = false;
        this.diagnostics.running = false;
        this.recognition = null;
        this.handlers.onError(info);
        this.handlers.onStatus("error");
        this.diagnostics.state = "error";
        return;
      }

      // Surface it (the UI shows a warning) but keep the session alive.
      this.handlers.onError(info);

      // A session that ends without producing anything must not count as a
      // fresh start for the backoff budget.
      if (!producedAnything) this.diagnostics.emptySessions += 1;
    };

    recognition.onend = () => {
      this.lastEndedAt = Date.now();
      if (!this.running) return;
      if (!producedFinal && producedAnything) {
        // Session ended with an uncommitted interim — it stays in pendingInterim
        // and will be merged into the next final (that is the word-loss fix).
      }
      this.scheduleRestart(Ctor, producedAnything ? "ended" : "no-speech");
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/already started/i.test(message)) {
        // A previous instance is still alive. Back off (do NOT retry at 0 ms —
        // that spun thousands of times a second and never let the session open).
        this.consecutiveErrors += 1;
        this.lastEndedAt = Date.now();
        this.scheduleRestart(Ctor, "aborted");
        return;
      }
      this.handlers.onError({
        code: "start-failed",
        title: "无法启动识别",
        detail: message,
        hint: "刷新页面；如果仍失败，检查是否有扩展或策略阻止了 Web Speech API。",
        fatal: true,
      });
      this.running = false;
      this.diagnostics.running = false;
      this.handlers.onStatus("error");
      this.diagnostics.state = "error";
    }
  }

  private bumpReason(reason: RestartReason): void {
    this.diagnostics.restartsByReason[reason] += 1;
  }

  /**
   * Restart the session. A normal end restarts immediately (every millisecond
   * of delay is audio the recognizer never hears); only repeated errors back
   * off, and even then we never abandon a running session.
   */
  private scheduleRestart(Ctor: SpeechRecognitionCtor, reason: RestartReason): void {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    this.restartTimes.push(now);
    this.diagnostics.restartCount += 1;
    this.bumpReason(reason);

    const speechActive = this.handlers.isSpeechActive?.() ?? false;
    const overBudget = this.restartTimes.length > RESTART_SOFT_LIMIT;
    // Immediate restart while someone is talking; small backoff after errors.
    const step = this.consecutiveErrors === 0 ? 0 : Math.min(this.consecutiveErrors, RESTART_BACKOFF_MS.length - 1);
    let delay = RESTART_BACKOFF_MS[step];
    // Device-open failures get progressively longer waits instead of a burst.
    if (reason === "audio-capture") delay = Math.max(delay, Math.min(500 * this.captureRetries, 5000));
    if (overBudget) delay = Math.max(delay, 1500);
    if (speechActive && this.consecutiveErrors === 0) delay = 0;

    this.handlers.onRestart?.({ count: this.diagnostics.restartCount, reason, gapMs: delay });
    this.handlers.onStatus(delay > 0 ? "restarting" : "listening");
    this.diagnostics.state = delay > 0 ? "restarting" : "listening";
    this.mark(`restart:${reason}`);
    this.lastRestartAt = now;

    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (!this.running) return;
      this.spawn(Ctor);
    }, delay);
  }
}

function reasonForError(code: string): RestartReason {
  if (code === "no-speech") return "no-speech";
  if (code === "network") return "network";
  if (code === "audio-capture") return "audio-capture";
  if (code === "aborted") return "aborted";
  return "unknown";
}

/**
 * Merge carried-over interim text with a new final. Delegates to the DSP
 * overlap merge so duplicated words around a restart are collapsed.
 */
export function mergeRecognitionText(carried: string, next: string): string {
  const left = carried.trim();
  const right = next.trim();
  if (!left) return right;
  if (!right) return left;
  return mergeTranscripts(left, right);
}

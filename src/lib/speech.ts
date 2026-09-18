import type { SpeechErrorInfo, SpeechStatus } from "@/types";

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
        hint: "Plug in or enable a microphone in the system sound settings.",
        fatal: true,
      };
    case "network":
      return {
        code,
        title: "Speech service unreachable",
        detail:
          message ||
          "Chrome's built-in recognizer sends audio to Google's speech service, and that request failed.",
        hint:
          "Check the network/proxy, or use a VPN. If Google is unreachable on this machine, live translation cannot work in this browser.",
        fatal: true,
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
}

const RESTART_WINDOW_MS = 60_000;
const RESTART_BUDGET = 12;
const RESTART_DELAY_MS = 350;

export class LiveRecognizer {
  private recognition: SpeechRecognitionLike | null = null;
  private handlers: LiveRecognizerHandlers;
  private running = false;
  private restartTimes: number[] = [];
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private language: string;

  constructor(handlers: LiveRecognizerHandlers, language: string) {
    this.handlers = handlers;
    this.language = language;
  }

  get isRunning(): boolean {
    return this.running;
  }

  get currentLanguage(): string {
    return this.language;
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
    this.handlers.onStatus("starting");
    this.spawn(Ctor);
  }

  stop(): void {
    this.running = false;
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
    this.handlers.onStatus("idle");
  }

  /** Switch recognition language without dropping the session. */
  setLanguage(language: string): void {
    if (language === this.language) return;
    this.language = language;
    if (!this.running) return;
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

  private spawn(Ctor: SpeechRecognitionCtor): void {
    if (!this.running) return;

    const recognition = new Ctor();
    recognition.lang = this.language;
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;

    recognition.onstart = () => {
      if (this.running) this.handlers.onStatus("listening");
    };

    recognition.onspeechstart = () => {
      if (this.running) this.handlers.onSpeechStart?.();
    };

    recognition.onresult = (event) => {
      if (!this.running) return;
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const transcript = result[0]?.transcript ?? "";
        if (result.isFinal) {
          const cleaned = transcript.trim();
          if (cleaned) this.handlers.onFinal(cleaned);
        } else {
          interim += transcript;
        }
      }
      this.handlers.onInterim(interim.trim());
    };

    recognition.onerror = (event) => {
      const info = describeSpeechError(event.error, event.message);
      if (info.code === "aborted" && !this.running) return;
      this.handlers.onError(info);
      if (info.fatal) {
        this.running = false;
        this.recognition = null;
        this.handlers.onStatus("error");
      }
    };

    recognition.onend = () => {
      if (!this.running) return;
      // Chrome ends the session on its own after a pause — restart it.
      this.scheduleRestart(Ctor);
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (err) {
      // "already started" is thrown if a previous instance is still alive.
      const message = err instanceof Error ? err.message : String(err);
      if (!/already started/i.test(message)) {
        this.handlers.onError({
          code: "start-failed",
          title: "Could not start recognition",
          detail: message,
          fatal: true,
        });
        this.running = false;
        this.handlers.onStatus("error");
      }
    }
  }

  private scheduleRestart(Ctor: SpeechRecognitionCtor): void {
    const now = Date.now();
    this.restartTimes = this.restartTimes.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restartTimes.length >= RESTART_BUDGET) {
      this.running = false;
      this.handlers.onError({
        code: "restart-loop",
        title: "Recognition keeps stopping",
        detail: `The recognizer restarted ${RESTART_BUDGET} times in a minute and kept ending immediately.`,
        hint: "Check the microphone device, or check whether the Google speech service is reachable from this network.",
        fatal: true,
      });
      this.handlers.onStatus("error");
      return;
    }
    this.restartTimes.push(now);
    this.handlers.onStatus("restarting");
    this.restartTimer = setTimeout(() => this.spawn(Ctor), RESTART_DELAY_MS);
  }
}

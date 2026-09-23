import { create } from "zustand";
import type {
  SpeechErrorInfo,
  SpeechStatus,
  TranslateSegment,
} from "@/types";
import {
  MAX_STORED_SEGMENTS,
  PREVIEW_DEBOUNCE_MS,
  STORAGE_KEYS,
} from "@/lib/constants";
import { DeepSeekError, toDeepSeekError } from "@/lib/errors";
import {
  AudioAnalyzer,
  applyProcessing,
  requestMicrophone,
  stopMicrophone,
  toMicError,
  type AnalyzerDisplay,
  type MicCaptureReport,
} from "@/lib/audio";
import type { CalibrationSample, VadFrame } from "@/lib/dsp";
import {
  LiveRecognizer,
  describeEnvironmentProblem,
  type RecognizerDiagnostics,
} from "@/lib/speech";
import { detectLanguage, resolveDirection, translateText } from "@/lib/translate";
import { uid } from "@/lib/utils";
import { useSettingsStore } from "./settingsStore";
import { showToast } from "./toastStore";

/**
 * Live-translation session state.
 *
 * Flow:  start() → mic permission → Web Speech recognition
 *        → final utterance → queued DeepSeek streaming translation → subtitle
 *
 * The translation queue is strictly sequential: one in-flight request at a
 * time keeps latency predictable and avoids tripping DeepSeek's rate limits
 * when someone talks continuously.
 */

export type VadSummary = Pick<
  VadFrame,
  | "speech"
  | "levelDb"
  | "smoothDb"
  | "noiseFloorDb"
  | "snrDb"
  | "peak"
  | "zcr"
  | "reason"
  | "speechMs"
  | "silenceMs"
  | "tooWeak"
  | "warmup"
>;

interface PersistedTranscript {
  segments: TranslateSegment[];
  startedAt: number | null;
  savedAt: number;
}

interface TranslateState {
  status: SpeechStatus;
  /** Unstable recognition text, shown live under the last segment. */
  interim: string;
  /** Live preview translation of the interim text (optional). */
  interimTranslation: string;
  interimSourceLang: string;
  interimTargetLang: string;
  segments: TranslateSegment[];
  error: SpeechErrorInfo | null;
  /** Non-fatal warning (network blip, weak signal…) shown as a banner. */
  warning: string | null;
  micLevel: number;
  /** Live analysis for the meter and the diagnostics panel. */
  analysis: AnalyzerDisplay | null;
  /** What the device actually gave us (constraints + real settings). */
  capture: MicCaptureReport | null;
  /** Recognizer lifecycle counters (restarts, gaps, last partial/final…). */
  recognition: RecognizerDiagnostics | null;
  /** Latest VAD frame summary for the diagnostics panel. */
  vad: VadSummary | null;
  /** Speech seen by the VAD but no recognition result for this long → hint. */
  unrecognisedSpeechMs: number;
  startedAt: number | null;
  hydrated: boolean;

  hydrate: () => void;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => Promise<void>;
  clear: () => void;
  setLanguage: (lang: string) => void;
  /** Re-read the far-field settings and apply them to the live capture. */
  applyAudioSettings: () => Promise<void>;
  clearWarning: () => void;

  /* ── Distance calibration (developer diagnostics) ─────────────────── */
  calibrating: boolean;
  calibrationDistance: number;
  startCalibration: (distanceM: number) => void;
  finishCalibration: () => CalibrationSample | null;

  /** Pull the live recognizer/VAD numbers into React state (diagnostics panel). */
  refreshDiagnostics: () => void;
  retranslate: (segmentId: string) => Promise<void>;
  copyAll: () => Promise<boolean>;
  exportTranscript: () => string;
  /** Internal: called by the recognizer. */
  pushInterim: (text: string) => void;
  pushFinal: (text: string) => void;
}

/* ── Module-level singletons (never persisted) ───────────────────────── */

let recognizer: LiveRecognizer | null = null;
let micStream: MediaStream | null = null;
let analyzer: AudioAnalyzer | null = null;
let activeAnalyzer: AudioAnalyzer | null = null;
/** Live VAD state, read by the recognizer when deciding how fast to restart. */
let vadSpeechActive = false;
let speechSince: number | null = null;
let unrecognisedSince: number | null = null;
let lastUnrecognisedWarn = 0;
/** Fires when a start never reaches "listening" (a session that silently died). */
let startWatchdog: ReturnType<typeof setTimeout> | undefined;
/** Notices a microphone that is producing digital silence after a restart. */
let silenceWatchdog: ReturnType<typeof setInterval> | undefined;
let silentFrames = 0;
let previewController: AbortController | null = null;
let activeController: AbortController | null = null;
let previewTimer: ReturnType<typeof setTimeout> | undefined;
let queue: string[] = [];
let draining = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleSave(segments: TranslateSegment[], startedAt: number | null) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const { settings } = useSettingsStore.getState();
    if (!settings.keepTranscript) return;
    const payload: PersistedTranscript = {
      segments: segments.slice(-MAX_STORED_SEGMENTS),
      startedAt,
      savedAt: Date.now(),
    };
    try {
      localStorage.setItem(STORAGE_KEYS.transcript, JSON.stringify(payload));
    } catch {
      /* quota — transcript is a convenience, never block the session */
    }
  }, 500);
}

function readPersisted(): PersistedTranscript | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.transcript);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedTranscript;
    if (!Array.isArray(parsed?.segments)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function contextPairs(segments: TranslateSegment[]) {
  return segments
    .filter((s) => s.status === "complete" && s.translation.trim())
    .map((s) => ({ source: s.source, translation: s.translation }));
}

export const useTranslateStore = create<TranslateState>((set, get) => ({
  status: "idle",
  interim: "",
  interimTranslation: "",
  interimSourceLang: "unknown",
  interimTargetLang: "unknown",
  segments: [],
  error: null,
  warning: null,
  micLevel: 0,
  analysis: null,
  capture: null,
  recognition: null,
  vad: null,
  unrecognisedSpeechMs: 0,
  startedAt: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const stored = readPersisted();
    // A reload can never resume a live session.
    set({
      segments: stored?.segments ?? [],
      startedAt: stored?.startedAt ?? null,
      hydrated: true,
    });
  },

  start: async () => {
    if (get().status === "listening" || get().status === "starting") return;

    const problem = describeEnvironmentProblem();
    if (problem) {
      set({
        status: "error",
        error: { code: "environment", ...problem, fatal: true },
      });
      showToast("error", problem.title, problem.detail);
      return;
    }

    const { apiKey, settings } = useSettingsStore.getState();
    if (!apiKey) {
      showToast("error", "Missing API Key", "Add your DeepSeek key before translating.");
      return;
    }

    set({ status: "starting", error: null, warning: null });

    // 1) Ask for the microphone — this is what raises the browser prompt.
    //    Far-field mode requests a raw capture (see src/lib/audio.ts).
    const micOptions = {
      farField: settings.farFieldMode,
      processing: settings.micProcessing,
      deviceId: settings.micDeviceId || undefined,
    };
    let captureReport: MicCaptureReport | null = null;
    try {
      const result = await requestMicrophone(micOptions);
      micStream = result.stream;
      captureReport = result.report;
    } catch (err) {
      const error = toMicError(err);
      set({
        status: "error",
        error: { code: "microphone", title: error.message, detail: error.detail, hint: error.hint, fatal: true },
      });
      showToast("error", error.message, error.detail);
      return;
    }

    // 2) Analyse the same microphone: RMS/peak/noise floor/SNR + VAD. This is
    //    what tells the user whether a distant voice is arriving at all.
    analyzer = new AudioAnalyzer(micStream, {
      preset: settings.farFieldMode ? "far" : "near",
      onFrame: (frame) => {
        vadSpeechActive = frame.speech;
        // Speech is present but recognition has produced nothing for a while —
        // the signature of a signal that is too weak for the cloud recognizer.
        if (frame.speech) {
          if (speechSince === null) speechSince = performance.now();
          unrecognisedSince ??= performance.now();
        } else {
          speechSince = null;
          unrecognisedSince = null;
        }
        const unrecognised =
          speechSince !== null && unrecognisedSince !== null
            ? performance.now() - unrecognisedSince
            : 0;
        if (unrecognised > 2500 && unrecognised - lastUnrecognisedWarn > 8000) {
          lastUnrecognisedWarn = unrecognised;
          set({ unrecognisedSpeechMs: Math.round(unrecognised) });
        }
      },
      onDisplay: (display) => set({ analysis: display, micLevel: display.level }),
    });
    analyzer.start();
    activeAnalyzer = analyzer;

    // 3) Start recognition in the configured language.
    const recognitionLang =
      settings.translateDirection === "zh-en"
        ? "zh-CN"
        : settings.translateDirection === "en-zh"
          ? "en-US"
          : settings.speechLang;

    recognizer = new LiveRecognizer(
      {
        onInterim: (text) => get().pushInterim(text),
        onFinal: (text) => {
          speechSince = null;
          unrecognisedSince = null;
          set({ unrecognisedSpeechMs: 0 });
          get().pushFinal(text);
        },
        onStatus: (status) => {
          if (status === "listening" && startWatchdog) {
            clearTimeout(startWatchdog);
            startWatchdog = undefined;
          }
          set({ status });
        },
        onError: (error) => {
          if (error.fatal) {
            set({ error });
            stopMicrophone(micStream);
            micStream = null;
            analyzer?.stop();
            analyzer = null;
            showToast("error", error.title, error.detail);
            return;
          }
          // Recoverable (network blip, no-speech, aborted): warn, keep going.
          set({ warning: `${error.title}${error.detail ? ` · ${error.detail}` : ""}` });
        },
        onRestart: ({ count, reason }) => {
          if (reason === "network" && count % 3 === 0) {
            set({ warning: "语音服务连接不稳定，正在自动重连…" });
          }
        },
        // The VAD tells the restarter whether someone is mid-sentence, so a
        // restart can be immediate instead of waiting out a fixed delay.
        isSpeechActive: () => vadSpeechActive,
      },
      recognitionLang
    );

    set({
      startedAt: Date.now(),
      capture: captureReport,
      vad: null,
      unrecognisedSpeechMs: 0,
    });
    recognizer.start(recognitionLang);

    // Watchdog: a start that never reaches "listening" must not leave the UI
    // hanging on 启动中 with no explanation (reported as "no reaction").
    if (startWatchdog) clearTimeout(startWatchdog);
    startWatchdog = setTimeout(() => {
      startWatchdog = undefined;
      const state = get();
      if (state.status !== "starting") return;
      recognizer?.stop();
      recognizer = null;
      analyzer?.stop();
      analyzer = null;
      activeAnalyzer = null;
      stopMicrophone(micStream);
      micStream = null;
      set({
        status: "error",
        // Drop the snapshot too, or diagnostics keep reporting a recognizer that
        // is no longer running.
        recognition: null,
        analysis: null,
        vad: null,
        micLevel: 0,
        error: {
          code: "start-timeout",
          title: "识别没有启动成功",
          detail: "浏览器接受了请求但没有开始返回识别结果（可能上一次会话还没有完全释放麦克风）。",
          hint: "再点一次「开始实时翻译」通常就恢复；若反复失败，请刷新页面。",
          fatal: true,
        },
      });
    }, 6000);

    // Watchdog: frames arriving but the microphone is digitally silent means the
    // device is held elsewhere / the wrong input was picked — the classic
    // "second session hears nothing" case.
    if (silenceWatchdog) clearInterval(silenceWatchdog);
    silenceWatchdog = setInterval(() => {
      const state = get();
      if (state.status !== "listening") return;
      const frame = activeAnalyzer?.latestFrame ?? null;
      if (!frame) return;
      if (frame.levelDb > -120) {
        silentFrames = 0;
        return;
      }
      silentFrames += 1;
      if (silentFrames < 8) return;
      silentFrames = 0;
      set({
        warning:
          "麦克风没有任何声音数据（-140 dBFS）。通常是被其他程序占用、选错了输入设备，或上一次会话还没释放麦克风 —— 停止后重新开始一次即可。",
      });
    }, 500);
  },

  stop: () => {
    if (startWatchdog) clearTimeout(startWatchdog);
    startWatchdog = undefined;
    if (silenceWatchdog) clearInterval(silenceWatchdog);
    silenceWatchdog = undefined;
    silentFrames = 0;
    recognizer?.stop();
    recognizer = null;
    stopMicrophone(micStream);
    micStream = null;
    analyzer?.stop();
    analyzer = null;
    activeAnalyzer = null;
    vadSpeechActive = false;
    speechSince = null;
    unrecognisedSince = null;
    lastUnrecognisedWarn = 0;
    previewController?.abort();
    previewController = null;
    activeController?.abort();
    activeController = null;
    queue = [];
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = undefined;
    set({
      status: "idle",
      interim: "",
      interimTranslation: "",
      micLevel: 0,
      analysis: null,
      vad: null,
      recognition: null,
      unrecognisedSpeechMs: 0,
    });
  },

  /** Apply far-field / processing / device changes to the running capture. */
  applyAudioSettings: async () => {
    const { settings } = useSettingsStore.getState();
    if (!micStream || !analyzer) return;
    const preset = settings.farFieldMode ? "far" : "near";
    analyzer.setPreset(preset);
    const report = await applyProcessing(micStream, {
      farField: settings.farFieldMode,
      processing: settings.micProcessing,
      deviceId: settings.micDeviceId || undefined,
    });
    set({ capture: report });
  },

  clearWarning: () => set({ warning: null }),

  calibrating: false,
  calibrationDistance: 1,

  startCalibration: (distanceM) => {
    if (!activeAnalyzer) {
      showToast("error", "先开始实时翻译", "校准需要麦克风处于开启状态。");
      return;
    }
    activeAnalyzer.startCalibration(distanceM);
    set({ calibrating: true, calibrationDistance: distanceM });
  },

  finishCalibration: () => {
    const sample = activeAnalyzer?.finishCalibration() ?? null;
    set({ calibrating: false });
    return sample;
  },

  refreshDiagnostics: () => {
    const frame = activeAnalyzer?.latestFrame ?? null;
    set({
      recognition: recognizer?.getDiagnostics() ?? null,
      vad: frame
        ? {
            speech: frame.speech,
            levelDb: frame.levelDb,
            smoothDb: frame.smoothDb,
            noiseFloorDb: frame.noiseFloorDb,
            snrDb: frame.snrDb,
            peak: frame.peak,
            zcr: frame.zcr,
            reason: frame.reason,
            speechMs: frame.speechMs,
            silenceMs: frame.silenceMs,
            tooWeak: frame.tooWeak,
            warmup: frame.warmup,
          }
        : null,
    });
  },

  toggle: async () => {
    const { status, start, stop } = get();
    if (status === "listening" || status === "starting" || status === "restarting") stop();
    else await start();
  },

  clear: () => {
    queue = [];
    set({ segments: [], interim: "", interimTranslation: "", startedAt: null, error: null });
    try {
      localStorage.removeItem(STORAGE_KEYS.transcript);
    } catch {
      /* ignore */
    }
  },

  setLanguage: (lang) => {
    recognizer?.setLanguage(lang);
    set({ interim: "", interimTranslation: "" });
  },

  retranslate: async (segmentId) => {
    const { segments } = get();
    const index = segments.findIndex((s) => s.id === segmentId);
    if (index === -1) return;
    const target = segments[index];

    patchSegment(set, segmentId, {
      translation: "",
      status: "streaming",
      error: undefined,
      preview: false,
    });
    await runTranslation(set, get, segmentId, target.source, index);
  },

  copyAll: async () => {
    const text = get().exportTranscript();
    if (!text) return false;
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  },

  exportTranscript: () => {
    const { segments, startedAt } = get();
    if (segments.length === 0) return "";
    const header = `TalkQ Web · 实时翻译记录 · ${new Date(startedAt ?? Date.now()).toLocaleString()}`;
    const body = segments
      .filter((s) => s.source.trim())
      .map((s) => `[${new Date(s.createdAt).toLocaleTimeString()}] ${s.source}\n→ ${s.translation || "(未翻译)"}`)
      .join("\n\n");
    return `${header}\n\n${body}\n`;
  },

  pushInterim: (text) => {
    const { settings } = useSettingsStore.getState();
    set({ interim: text });

    if (!settings.livePreview || !text.trim()) {
      if (previewTimer) clearTimeout(previewTimer);
      return;
    }
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void runPreviewTranslation(set), PREVIEW_DEBOUNCE_MS);
  },

  pushFinal: (text) => {
    const cleaned = text.trim();
    if (!cleaned) return;

    if (previewTimer) clearTimeout(previewTimer);
    previewController?.abort();
    previewController = null;

    const { settings } = useSettingsStore.getState();
    const resolved = resolveDirection(settings.translateDirection, cleaned);
    const segment: TranslateSegment = {
      id: uid("seg"),
      source: cleaned,
      translation: get().interimTranslation, // keep the preview text until the real one streams in
      status: "streaming",
      sourceLang: detectLanguage(cleaned),
      targetLang: resolved.target,
      createdAt: Date.now(),
    };

    const segments = [...get().segments, segment];
    set({ segments, interim: "", interimTranslation: "" });
    scheduleSave(segments, get().startedAt);

    queue.push(segment.id);
    void drainQueue(set, get);
  },
}));

/* ── Helpers ─────────────────────────────────────────────────────────── */

type SetState = (partial: Partial<TranslateState> | ((state: TranslateState) => Partial<TranslateState>)) => void;
type GetState = () => TranslateState;

function patchSegment(set: SetState, id: string, patch: Partial<TranslateSegment>) {
  set((state) => ({
    segments: state.segments.map((s) => (s.id === id ? { ...s, ...patch } : s)),
  }));
}

async function runPreviewTranslation(set: SetState) {
  const state = useTranslateStore.getState();
  const text = state.interim.trim();
  if (!text) return;

  const { apiKey, settings } = useSettingsStore.getState();
  if (!apiKey) return;

  previewController?.abort();
  const controller = new AbortController();
  previewController = controller;

  const resolved = resolveDirection(settings.translateDirection, text);
  set({
    interimTranslation: "",
    interimSourceLang: resolved.source,
    interimTargetLang: resolved.target,
  });

  try {
    const result = await translateText({
      apiKey,
      text,
      direction: settings.translateDirection,
      quickMode: settings.translateQuickMode,
      signal: controller.signal,
      onDelta: () => {
        // Deltas arrive here but we only render the cleaned result for previews.
      },
    });
    if (controller.signal.aborted) return;
    set({ interimTranslation: result.translation });
  } catch {
    // Previews are best-effort: a failure here must never surface as an error.
  } finally {
    if (previewController === controller) previewController = null;
  }
}

async function drainQueue(set: SetState, get: GetState) {
  if (draining) return;
  draining = true;
  try {
    while (queue.length > 0) {
      const id = queue.shift()!;
      const index = get().segments.findIndex((s) => s.id === id);
      if (index === -1) continue;
      const segment = get().segments[index];
      await runTranslation(set, get, id, segment.source, index);
    }
  } finally {
    draining = false;
  }
}

async function runTranslation(
  set: SetState,
  get: GetState,
  segmentId: string,
  text: string,
  index: number
) {
  const { apiKey, settings } = useSettingsStore.getState();
  if (!apiKey) {
    patchSegment(set, segmentId, { status: "error", error: "Missing API key" });
    return;
  }

  const controller = new AbortController();
  activeController = controller;

  const context = contextPairs(get().segments.slice(0, index));
  const startedAt = performance.now();

  try {
    const result = await translateText({
      apiKey,
      text,
      direction: settings.translateDirection,
      context,
      quickMode: settings.translateQuickMode,
      signal: controller.signal,
      onDelta: (delta) => {
        set((state) => ({
          segments: state.segments.map((s) =>
            s.id === segmentId ? { ...s, translation: s.translation + delta } : s
          ),
        }));
      },
    });

    patchSegment(set, segmentId, {
      translation: result.translation,
      sourceLang: result.source,
      targetLang: result.target,
      status: result.aborted ? "aborted" : "complete",
      durationMs: performance.now() - startedAt,
      error: undefined,
    });
  } catch (err) {
    const error = err instanceof DeepSeekError ? err : toDeepSeekError(err);
    if (error.kind === "aborted") {
      patchSegment(set, segmentId, { status: "aborted", durationMs: performance.now() - startedAt });
    } else {
      patchSegment(set, segmentId, {
        status: "error",
        error: `${error.message}${error.detail ? ` · ${error.detail}` : ""}`,
        durationMs: performance.now() - startedAt,
      });
      showToast("error", error.message, error.detail);
    }
  } finally {
    if (activeController === controller) activeController = null;
    scheduleSave(get().segments, get().startedAt);
  }
}

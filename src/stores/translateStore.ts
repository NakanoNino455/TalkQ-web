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
import { describeMicError, requestMicrophone, startLevelMeter, stopMicrophone, type LevelMeterHandle } from "@/lib/mic";
import { LiveRecognizer, describeEnvironmentProblem } from "@/lib/speech";
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
  micLevel: number;
  startedAt: number | null;
  hydrated: boolean;

  hydrate: () => void;
  start: () => Promise<void>;
  stop: () => void;
  toggle: () => Promise<void>;
  clear: () => void;
  setLanguage: (lang: string) => void;
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
let meter: LevelMeterHandle | null = null;
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
  micLevel: 0,
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

    set({ status: "starting", error: null });

    // 1) Ask for the microphone — this is what raises the browser prompt.
    try {
      micStream = await requestMicrophone();
    } catch (err) {
      const info = describeMicError(err);
      set({
        status: "error",
        error: { code: "microphone", title: info.title, detail: info.detail, hint: info.hint, fatal: info.fatal },
      });
      showToast("error", info.title, info.detail);
      return;
    }

    meter = startLevelMeter(micStream, (level) => set({ micLevel: level }));

    // 2) Start recognition in the configured language.
    const recognitionLang =
      settings.translateDirection === "zh-en"
        ? "zh-CN"
        : settings.translateDirection === "en-zh"
          ? "en-US"
          : settings.speechLang;

    recognizer = new LiveRecognizer(
      {
        onInterim: (text) => get().pushInterim(text),
        onFinal: (text) => get().pushFinal(text),
        onStatus: (status) => set({ status }),
        onError: (error) => {
          set({ error });
          if (error.fatal) {
            stopMicrophone(micStream);
            micStream = null;
            meter?.stop();
            meter = null;
            showToast("error", error.title, error.detail);
          }
        },
      },
      recognitionLang
    );

    set({ startedAt: Date.now() });
    recognizer.start(recognitionLang);
  },

  stop: () => {
    recognizer?.stop();
    recognizer = null;
    stopMicrophone(micStream);
    micStream = null;
    meter?.stop();
    meter = null;
    previewController?.abort();
    previewController = null;
    activeController?.abort();
    activeController = null;
    queue = [];
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = undefined;
    set({ status: "idle", interim: "", interimTranslation: "", micLevel: 0 });
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
    const header = `NexQ Web · 实时翻译记录 · ${new Date(startedAt ?? Date.now()).toLocaleString()}`;
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

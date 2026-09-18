import { create } from "zustand";
import type { AppSettings, MessageError } from "@/types";
import { DEFAULT_SETTINGS, MODEL_LABEL, MODEL_VERSION_LABEL } from "@/lib/constants";
import { DeepSeekError, toDeepSeekError } from "@/lib/errors";
import { testConnection } from "@/lib/deepseek";
import {
  clearStoredApiKey,
  loadApiKey,
  loadSettings,
  saveApiKey,
  saveSettings,
} from "@/lib/storage";
import { showToast } from "./toastStore";

export type ConnectionState = "idle" | "testing" | "ok" | "error";

export interface ConnectionInfo {
  model: string;
  latencyMs: number;
  reply: string;
  checkedAt: number;
}

interface SettingsState {
  /** null until the user has provided a key — this is what gates the UI. */
  apiKey: string | null;
  settings: AppSettings;
  /** True once localStorage has been read (avoids a first-paint flash). */
  hydrated: boolean;
  connection: ConnectionState;
  connectionInfo: ConnectionInfo | null;
  connectionError: MessageError | null;

  hydrate: () => void;
  setApiKey: (key: string) => void;
  clearApiKey: () => void;
  updateSettings: (patch: Partial<AppSettings>) => void;
  resetSettings: () => void;
  runConnectionTest: (keyOverride?: string) => Promise<boolean>;
  resetConnection: () => void;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  apiKey: null,
  settings: { ...DEFAULT_SETTINGS },
  hydrated: false,
  connection: "idle",
  connectionInfo: null,
  connectionError: null,

  hydrate: () => {
    if (get().hydrated) return;
    set({
      apiKey: loadApiKey(),
      settings: loadSettings(),
      hydrated: true,
    });
  },

  setApiKey: (key) => {
    const trimmed = key.trim();
    if (!trimmed) return;
    saveApiKey(trimmed);
    set({ apiKey: trimmed, connection: "idle", connectionError: null, connectionInfo: null });
  },

  clearApiKey: () => {
    clearStoredApiKey();
    set({
      apiKey: null,
      connection: "idle",
      connectionInfo: null,
      connectionError: null,
    });
  },

  updateSettings: (patch) => {
    const next = { ...get().settings, ...patch };
    saveSettings(next);
    set({ settings: next });
  },

  resetSettings: () => {
    saveSettings({ ...DEFAULT_SETTINGS });
    set({ settings: { ...DEFAULT_SETTINGS } });
  },

  runConnectionTest: async (keyOverride) => {
    const apiKey = (keyOverride ?? get().apiKey ?? "").trim();
    if (!apiKey) {
      set({
        connection: "error",
        connectionError: {
          kind: "auth",
          title: "Enter your DeepSeek API Key",
          detail: "A key is required before the connection can be tested.",
        },
      });
      return false;
    }

    set({ connection: "testing", connectionError: null });
    try {
      const result = await testConnection(apiKey);
      set({
        connection: "ok",
        connectionInfo: {
          model: result.model,
          latencyMs: result.latencyMs,
          reply: result.reply,
          checkedAt: Date.now(),
        },
        connectionError: null,
      });
      return true;
    } catch (err) {
      const error = err instanceof DeepSeekError ? err : toDeepSeekError(err);
      set({ connection: "error", connectionError: error.toMessageError(), connectionInfo: null });
      if (error.kind !== "aborted") {
        showToast("error", error.message, error.detail);
      }
      return false;
    }
  },

  resetConnection: () => set({ connection: "idle", connectionError: null, connectionInfo: null }),
}));

/** Non-hook convenience for components that only need a label. */
export const MODEL_INFO = {
  label: MODEL_LABEL,
  version: MODEL_VERSION_LABEL,
};

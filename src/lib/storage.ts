import type { AppSettings, ChatMessage, Conversation } from "@/types";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "./constants";

/**
 * localStorage persistence. This is the *only* datastore in the app:
 *
 *   nexq_deepseek_api_key  — the user's DeepSeek key (never leaves the browser
 *                            except in the Authorization header to DeepSeek)
 *   nexq_settings          — UI + request preferences
 *   nexq_chat_history      — conversations / messages, including image data URLs
 *
 * No .env, no server-side secret, nothing committed to the repository.
 */

function safeGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): boolean {
  try {
    window.localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

/* ── API key ─────────────────────────────────────────────────────────── */

export function loadApiKey(): string | null {
  const raw = safeGet(STORAGE_KEYS.apiKey);
  const key = raw?.trim();
  return key ? key : null;
}

export function saveApiKey(key: string): void {
  safeSet(STORAGE_KEYS.apiKey, key.trim());
}

export function clearStoredApiKey(): void {
  safeRemove(STORAGE_KEYS.apiKey);
}

/* ── Settings ────────────────────────────────────────────────────────── */

export function loadSettings(): AppSettings {
  const raw = safeGet(STORAGE_KEYS.settings);
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      // Guard against corrupt/hostile values.
      imageDetail: (["auto", "low", "high", "original"] as const).includes(
        parsed.imageDetail as never
      )
        ? (parsed.imageDetail as AppSettings["imageDetail"])
        : DEFAULT_SETTINGS.imageDetail,
      systemPrompt: typeof parsed.systemPrompt === "string" ? parsed.systemPrompt : "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  safeSet(STORAGE_KEYS.settings, JSON.stringify(settings));
}

/* ── Chat history ────────────────────────────────────────────────────── */

function isMessage(value: unknown): value is ChatMessage {
  if (!value || typeof value !== "object") return false;
  const m = value as Partial<ChatMessage>;
  return (
    typeof m.id === "string" &&
    typeof m.content === "string" &&
    (m.role === "user" || m.role === "assistant" || m.role === "system")
  );
}

export function loadConversations(): Conversation[] {
  const raw = safeGet(STORAGE_KEYS.chatHistory);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is Conversation => {
        if (!c || typeof c !== "object") return false;
        const conv = c as Partial<Conversation>;
        return typeof conv.id === "string" && Array.isArray(conv.messages);
      })
      .map((conv) => ({
        ...conv,
        title: typeof conv.title === "string" && conv.title ? conv.title : "New chat",
        createdAt: conv.createdAt ?? Date.now(),
        updatedAt: conv.updatedAt ?? conv.createdAt ?? Date.now(),
        messages: conv.messages
          .filter(isMessage)
          // A reload can never resume a live stream.
          .map((m) => (m.status === "streaming" ? { ...m, status: "aborted" as const } : m)),
      }));
  } catch {
    return [];
  }
}

/** Returns false when the quota is exceeded, so callers can warn the user. */
export function saveConversations(conversations: Conversation[]): boolean {
  const payload = JSON.stringify(conversations);
  if (safeSet(STORAGE_KEYS.chatHistory, payload)) return true;
  // Most likely QuotaExceededError from stored image data URLs — retry without
  // image payloads rather than losing the whole history.
  try {
    const slim = conversations.map((conv) => ({
      ...conv,
      messages: conv.messages.map((m) =>
        m.images?.length
          ? { ...m, images: m.images.map((img) => ({ ...img, dataUrl: "" })) }
          : m
      ),
    }));
    return safeSet(STORAGE_KEYS.chatHistory, JSON.stringify(slim));
  } catch {
    return false;
  }
}

export function clearStoredHistory(): void {
  safeRemove(STORAGE_KEYS.chatHistory);
}

/** Everything this app stores, for the "Erase local data" action. */
export function eraseAllLocalData(): void {
  safeRemove(STORAGE_KEYS.chatHistory);
  safeRemove(STORAGE_KEYS.transcript);
  safeRemove(STORAGE_KEYS.settings);
  safeRemove(STORAGE_KEYS.apiKey);
}

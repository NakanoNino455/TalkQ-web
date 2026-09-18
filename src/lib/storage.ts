import type { AppSettings, ChatMessage, Conversation, DocumentAttachment } from "@/types";
import { DEFAULT_SETTINGS, LEGACY_STORAGE_KEYS, STORAGE_KEYS } from "./constants";

/**
 * localStorage persistence. This is the *only* datastore in the app:
 *
 *   talkq_deepseek_api_key  — the user's DeepSeek key (never leaves the browser
 *                             except in the Authorization header to DeepSeek)
 *   talkq_settings          — UI + request preferences
 *   talkq_chat_history      — conversations / messages, including image data URLs
 *   talkq_translate_transcript — live-translation subtitles
 *
 * No .env, no server-side secret, nothing committed to the repository.
 */

/**
 * One-time move from the pre-rename `nexq_*` keys. The old entries are left in
 * place (harmless, and they keep working if someone rolls back a deployment).
 */
export function migrateLegacyStorage(): void {
  const pairs: Array<[string, string]> = [
    [LEGACY_STORAGE_KEYS.apiKey, STORAGE_KEYS.apiKey],
    [LEGACY_STORAGE_KEYS.settings, STORAGE_KEYS.settings],
    [LEGACY_STORAGE_KEYS.chatHistory, STORAGE_KEYS.chatHistory],
    [LEGACY_STORAGE_KEYS.transcript, STORAGE_KEYS.transcript],
  ];
  for (const [legacyKey, newKey] of pairs) {
    try {
      if (window.localStorage.getItem(newKey) !== null) continue;
      const value = window.localStorage.getItem(legacyKey);
      if (value !== null) window.localStorage.setItem(newKey, value);
    } catch {
      /* private mode / quota — nothing to migrate */
    }
  }
}

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
  safeRemove(STORAGE_KEYS.documents);
  safeRemove(STORAGE_KEYS.settings);
  safeRemove(STORAGE_KEYS.apiKey);
}

/* ── Attached documents (text extracted from PDF/TXT/DOCX) ───────────── */

/** Above this the tray is kept in memory only, to protect the quota. */
const MAX_PERSISTED_DOCUMENT_BYTES = 1_500_000;

export function loadDocuments(): DocumentAttachment[] {
  const raw = safeGet(STORAGE_KEYS.documents);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (doc): doc is DocumentAttachment =>
        Boolean(doc) &&
        typeof doc === "object" &&
        typeof (doc as DocumentAttachment).id === "string" &&
        typeof (doc as DocumentAttachment).name === "string" &&
        typeof (doc as DocumentAttachment).text === "string"
    );
  } catch {
    return [];
  }
}

/** Returns false when the tray was too large to persist (it still works in memory). */
export function saveDocuments(documents: DocumentAttachment[]): boolean {
  if (documents.length === 0) {
    safeRemove(STORAGE_KEYS.documents);
    return true;
  }
  const payload = JSON.stringify(documents);
  if (payload.length > MAX_PERSISTED_DOCUMENT_BYTES) return false;
  return safeSet(STORAGE_KEYS.documents, payload);
}

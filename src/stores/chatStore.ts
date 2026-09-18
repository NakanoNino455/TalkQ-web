import { create } from "zustand";
import type { ChatMessage, Conversation, ImageAttachment, MessageError } from "@/types";
import { DEEPSEEK_MODEL } from "@/lib/constants";
import { buildApiMessages, streamChat } from "@/lib/deepseek";
import { DeepSeekError, isRetryable, toDeepSeekError } from "@/lib/errors";
import { assertBodyBudget, composeUserText } from "@/lib/images";
import { loadConversations, saveConversations } from "@/lib/storage";
import { truncate, uid } from "@/lib/utils";
import { useSettingsStore } from "./settingsStore";
import { showToast } from "./toastStore";

/**
 * Chat state: conversations, the composer draft, and the live streaming
 * lifecycle (including the AbortController behind "Stop generating").
 * Only `conversations` is persisted, to `talkq_chat_history`.
 */

interface ChatState {
  conversations: Conversation[];
  activeId: string | null;
  draft: string;
  draftImages: ImageAttachment[];
  isStreaming: boolean;
  streamingMessageId: string | null;
  hydrated: boolean;

  hydrate: () => void;
  newChat: () => void;
  selectChat: (id: string) => void;
  deleteChat: (id: string) => void;
  renameChat: (id: string, title: string) => void;
  clearAllChats: () => void;

  setDraft: (text: string) => void;
  addDraftImages: (images: ImageAttachment[]) => void;
  removeDraftImage: (id: string) => void;
  clearDraftImages: () => void;

  send: (overrideText?: string, options?: { contextText?: string }) => Promise<void>;
  stop: () => void;
  regenerate: (messageId: string) => Promise<void>;
  deleteMessage: (messageId: string) => void;
}

let saveTimer: ReturnType<typeof setTimeout> | undefined;
let activeController: AbortController | null = null;

function schedulePersist(conversations: Conversation[]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const ok = saveConversations(conversations);
    if (!ok) {
      showToast(
        "error",
        "Local storage is full",
        "Old image attachments were dropped from disk. Delete an old chat to free space."
      );
    }
  }, 600);
}

function persistNow(conversations: Conversation[]) {
  if (saveTimer) clearTimeout(saveTimer);
  saveConversations(conversations);
}

function makeConversation(): Conversation {
  const now = Date.now();
  return { id: uid("chat"), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

function makeMessage(
  role: ChatMessage["role"],
  content: string,
  extra: Partial<ChatMessage> = {}
): ChatMessage {
  return {
    id: uid("msg"),
    role,
    content,
    createdAt: Date.now(),
    status: "complete",
    ...extra,
  };
}

function titleFor(text: string, imageCount: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean) return truncate(clean, 48);
  return imageCount > 0 ? "Image analysis" : "New chat";
}

export const useChatStore = create<ChatState>((set, get) => ({
  conversations: [],
  activeId: null,
  draft: "",
  draftImages: [],
  isStreaming: false,
  streamingMessageId: null,
  hydrated: false,

  hydrate: () => {
    if (get().hydrated) return;
    const conversations = loadConversations().sort((a, b) => b.updatedAt - a.updatedAt);
    set({
      conversations,
      activeId: conversations[0]?.id ?? null,
      hydrated: true,
    });
  },

  newChat: () => {
    if (get().isStreaming) get().stop();
    set({ activeId: null, draft: "", draftImages: [] });
  },

  selectChat: (id) => {
    if (get().isStreaming) get().stop();
    set({ activeId: id, draft: "", draftImages: [] });
  },

  deleteChat: (id) => {
    if (get().streamingMessageId && get().activeId === id) get().stop();
    const next = get().conversations.filter((c) => c.id !== id);
    set({
      conversations: next,
      activeId: get().activeId === id ? (next[0]?.id ?? null) : get().activeId,
    });
    persistNow(next);
    showToast("info", "Chat deleted");
  },

  renameChat: (id, title) => {
    const next = get().conversations.map((c) =>
      c.id === id ? { ...c, title: title.trim() || c.title } : c
    );
    set({ conversations: next });
    persistNow(next);
  },

  clearAllChats: () => {
    if (get().isStreaming) get().stop();
    set({ conversations: [], activeId: null });
    persistNow([]);
    showToast("info", "All chats deleted");
  },

  setDraft: (text) => set({ draft: text }),

  addDraftImages: (images) => {
    if (images.length === 0) return;
    set((state) => ({ draftImages: [...state.draftImages, ...images] }));
  },

  removeDraftImage: (id) =>
    set((state) => ({ draftImages: state.draftImages.filter((img) => img.id !== id) })),

  clearDraftImages: () => set({ draftImages: [] }),

  send: async (overrideText, options) => {
    const state = get();
    if (state.isStreaming) return;

    const text = (overrideText ?? state.draft).trim();
    const images = state.draftImages;
    const composed = composeUserText(text, images.length);
    if (!composed) return;

    try {
      assertBodyBudget(images);
    } catch (err) {
      const error = toDeepSeekError(err);
      showToast("error", error.message, error.detail);
      return;
    }

    // Materialise the conversation on first send (New Chat stays lazy).
    let conversations = state.conversations;
    let conversationId = state.activeId;
    if (!conversationId || !conversations.some((c) => c.id === conversationId)) {
      const created = makeConversation();
      conversations = [created, ...conversations];
      conversationId = created.id;
    }

    const userMessage = makeMessage("user", composed, {
      images: images.length ? images : undefined,
    });

    const updatedConversations = conversations.map((c) =>
      c.id === conversationId
        ? {
            ...c,
            title: c.messages.length === 0 ? titleFor(composed, images.length) : c.title,
            messages: [...c.messages, userMessage],
            updatedAt: Date.now(),
          }
        : c
    );

    set({
      conversations: updatedConversations,
      activeId: conversationId,
      draft: "",
      draftImages: [],
    });
    schedulePersist(updatedConversations);

    const history = updatedConversations.find((c) => c.id === conversationId)!.messages;
    await runCompletion(conversationId, history, set, get, options?.contextText);
  },

  stop: () => {
    if (activeController) {
      activeController.abort();
      activeController = null;
    }
  },

  regenerate: async (messageId) => {
    const state = get();
    if (state.isStreaming) return;

    const conversation = state.conversations.find((c) =>
      c.messages.some((m) => m.id === messageId)
    );
    if (!conversation) return;

    const index = conversation.messages.findIndex((m) => m.id === messageId);
    if (index === -1) return;

    // Drop the target message and everything after it, then re-run the request.
    const trimmed = conversation.messages.slice(0, index);
    if (trimmed.length === 0) return;

    const conversations = state.conversations.map((c) =>
      c.id === conversation.id ? { ...c, messages: trimmed, updatedAt: Date.now() } : c
    );
    set({ conversations });
    schedulePersist(conversations);

    await runCompletion(conversation.id, trimmed, set, get);
  },

  deleteMessage: (messageId) => {
    const conversations = get().conversations.map((c) => ({
      ...c,
      messages: c.messages.filter((m) => m.id !== messageId),
    }));
    set({ conversations });
    persistNow(conversations);
  },
}));

type SetState = (partial: Partial<ChatState> | ((state: ChatState) => Partial<ChatState>)) => void;
type GetState = () => ChatState;

/** Retry messaging matches the reason the first attempt failed. */
const RETRY_COPY: Partial<Record<MessageError["kind"], string>> = {
  server: "DeepSeek is busy — retrying once",
  rate_limit: "Rate limited — retrying once",
  network: "Network hiccup — retrying once",
  timeout: "Request stalled — retrying once",
};

/**
 * Shared streaming runner for `send` / `regenerate`.
 * Creates the assistant placeholder, streams deltas into it (throttled to
 * ~20fps so React is not re-rendered per token), and always resolves to a
 * terminal status — even on failure or user abort.
 */
async function runCompletion(
  conversationId: string,
  history: ChatMessage[],
  set: SetState,
  get: GetState,
  contextText?: string
): Promise<void> {
  const { apiKey, settings } = useSettingsStore.getState();
  if (!apiKey) {
    showToast("error", "Missing API Key", "Add your DeepSeek API key to start chatting.");
    return;
  }

  const assistant = makeMessage("assistant", "", {
    status: "streaming",
    model: DEEPSEEK_MODEL,
  });

  set((state) => ({
    conversations: state.conversations.map((c) =>
      c.id === conversationId
        ? { ...c, messages: [...c.messages, assistant], updatedAt: Date.now() }
        : c
    ),
    isStreaming: true,
    streamingMessageId: assistant.id,
  }));

  const patchMessage = (patch: Partial<ChatMessage>) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === conversationId
          ? {
              ...c,
              messages: c.messages.map((m) => (m.id === assistant.id ? { ...m, ...patch } : m)),
            }
          : c
      ),
    }));
  };

  let content = "";
  let reasoning = "";
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    flushTimer = undefined;
    if (!dirty) return;
    dirty = false;
    patchMessage({ content, reasoning: reasoning || undefined });
  };
  const scheduleFlush = () => {
    if (flushTimer) return;
    flushTimer = setTimeout(flush, 50);
  };

  const controller = new AbortController();
  activeController = controller;

  const apiMessages = buildApiMessages(history, settings, contextText);

  try {
    let attempt = 0;
    let result: Awaited<ReturnType<typeof streamChat>> | null = null;

    while (attempt < 2) {
      try {
        result = await streamChat({
          apiKey,
          messages: apiMessages,
          signal: controller.signal,
          thinkingEnabled: settings.thinkingEnabled,
          onContent: (delta) => {
            content += delta;
            dirty = true;
            scheduleFlush();
          },
          onReasoning: (delta) => {
            reasoning += delta;
            dirty = true;
            scheduleFlush();
          },
        });
        break;
      } catch (err) {
        const error = err instanceof DeepSeekError ? err : toDeepSeekError(err);
        const canRetry =
          attempt === 0 &&
          isRetryable(error.kind) &&
          !controller.signal.aborted &&
          content.length === 0 &&
          reasoning.length === 0;
        if (!canRetry) throw error;
        attempt += 1;
        showToast("info", RETRY_COPY[error.kind] ?? "Retrying the request", error.detail);
        await new Promise((resolve) => setTimeout(resolve, 1200));
      }
    }

    if (flushTimer) clearTimeout(flushTimer);
    const final = result!;

    patchMessage({
      content: final.content,
      reasoning: final.reasoning || undefined,
      status: final.aborted ? "aborted" : "complete",
      usage: final.usage ?? null,
      durationMs: final.durationMs,
      model: final.model,
      error: null,
    });
  } catch (err) {
    if (flushTimer) clearTimeout(flushTimer);
    const error = err instanceof DeepSeekError ? err : toDeepSeekError(err);

    if (error.kind === "aborted") {
      patchMessage({
        content,
        reasoning: reasoning || undefined,
        status: "aborted",
        error: null,
      });
    } else {
      patchMessage({
        content,
        reasoning: reasoning || undefined,
        status: "error",
        error: error.toMessageError(),
      });
      showToast("error", error.message, error.detail);
    }
  } finally {
    activeController = null;
    set({ isStreaming: false, streamingMessageId: null });
    persistNow(get().conversations);
  }
}

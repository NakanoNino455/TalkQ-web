/**
 * Single source of truth for everything DeepSeek + persistence related.
 * The only network origin this app ever talks to is DEEPSEEK_BASE_URL.
 */

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const CHAT_COMPLETIONS_URL = `${DEEPSEEK_BASE_URL}/chat/completions`;

/** Current official Flash model name (DeepSeek-V4.1-Flash). */
export const DEEPSEEK_MODEL = "deepseek-flash";
export const MODEL_LABEL = "DeepSeek Flash";
export const MODEL_VERSION_LABEL = "DeepSeek-V4.1-Flash";

/** 1M context window — never clamped to legacy 4K/8K/32K/128K limits. */
export const CONTEXT_WINDOW_TOKENS = 1_000_000;
export const CONTEXT_WINDOW_LABEL = "1M Context";
export const MAX_OUTPUT_TOKENS_LABEL = "384K output";

/** localStorage keys (browser-only storage, nothing is uploaded anywhere). */
export const STORAGE_KEYS = {
  apiKey: "nexq_deepseek_api_key",
  settings: "nexq_settings",
  chatHistory: "nexq_chat_history",
} as const;

/** Vision limits published by DeepSeek. */
export const IMAGE_LIMITS = {
  formats: ["image/jpeg", "image/png", "image/gif", "image/webp"] as const,
  formatLabels: "JPEG, PNG, GIF, WebP",
  maxFileBytes: 32 * 1024 * 1024, // 32 MiB per image
  maxBodyBytes: 48 * 1024 * 1024, // 48 MiB per request body
  maxPerRequest: 600,
};

export const ACCEPT_ATTR = IMAGE_LIMITS.formats.join(",");

/** Used when the user sends images without any text. */
export const DEFAULT_IMAGE_PROMPT = "请详细分析这张图片，并解释你看到的内容。";

/** Streaming watchdog: abort if the connection stalls. */
export const FIRST_TOKEN_TIMEOUT_MS = 45_000;
export const IDLE_TIMEOUT_MS = 90_000;
/** After `[DONE]`, how long to wait for the server to close the response. */
export const DONE_GRACE_MS = 2_000;

export const DEFAULT_SETTINGS = {
  thinkingEnabled: true,
  showReasoning: true,
  systemPrompt: "",
  sendOnEnter: true,
  keepHistoryImages: true,
  imageDetail: "auto" as const,
};

export const APP_NAME = "NexQ";
export const APP_SUBTITLE = "NexQ Web";

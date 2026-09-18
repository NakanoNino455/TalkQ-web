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
  apiKey: "talkq_deepseek_api_key",
  settings: "talkq_settings",
  chatHistory: "talkq_chat_history",
  transcript: "talkq_translate_transcript",
} as const;

/**
 * Keys used before the TalkQ rename. `migrateLegacyStorage()` copies them over
 * once, so an existing key / chat history survives the rebrand.
 */
export const LEGACY_STORAGE_KEYS = {
  apiKey: "nexq_deepseek_api_key",
  settings: "nexq_settings",
  chatHistory: "nexq_chat_history",
  transcript: "nexq_translate_transcript",
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
  translateDirection: "auto" as const,
  speechLang: "zh-CN" as const,
  livePreview: true,
  translateQuickMode: true,
  keepTranscript: true,
  askPanelOpen: true,
  askUseTranscriptContext: true,
};

/* ── Live translation ────────────────────────────────────────────────── */

/** Recognition languages offered by the Web Speech API (Chrome/Edge). */
export const SPEECH_LANGUAGES = [
  { value: "zh-CN", label: "中文（普通话）" },
  { value: "en-US", label: "English (US)" },
  { value: "ja-JP", label: "日本語" },
  { value: "ko-KR", label: "한국어" },
] as const;

export const TRANSLATE_DIRECTIONS = [
  { value: "auto", label: "自动互译", hint: "按每句话的语言自动决定方向" },
  { value: "zh-en", label: "中文 → English", hint: "你说中文，输出英文" },
  { value: "en-zh", label: "English → 中文", hint: "听英文，输出中文" },
] as const;

export const LANG_LABELS: Record<string, string> = {
  zh: "中文",
  en: "EN",
  ja: "日本語",
  ko: "한국어",
  unknown: "?",
};

/**
 * Translation system prompt. Deliberately terse: this runs once per utterance,
 * so prompt tokens are paid on every single segment.
 */
export const TRANSLATE_SYSTEM_PROMPT = [
  "You are a real-time simultaneous interpretation engine.",
  "Translate the user's text and output ONLY the translation.",
  "Never explain, never add quotes, never use markdown fences, never repeat the source.",
  "Keep names, numbers, technical terms and the original tone.",
  "If the text is already in the target language, return it unchanged.",
].join(" ");

/** How many previous segment pairs are sent as context for consistency. */
export const TRANSLATE_CONTEXT_PAIRS = 4;

/** Latency budgets for translation (snappier than chat). */
export const TRANSLATE_FIRST_TOKEN_TIMEOUT_MS = 20_000;
export const TRANSLATE_IDLE_TIMEOUT_MS = 30_000;

/** Interim text must be stable this long before a preview translation starts. */
export const PREVIEW_DEBOUNCE_MS = 900;

/** Persisted transcript cap (keeps localStorage quota healthy). */
export const MAX_STORED_SEGMENTS = 200;

export const APP_NAME = "TalkQ";
export const APP_SUBTITLE = "TalkQ Web";

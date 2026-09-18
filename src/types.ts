/** Domain types for the browser-only NexQ Web client. */

export type Role = "system" | "user" | "assistant";

/** An image the user attached to a message (kept as a base64 data URL). */
export interface ImageAttachment {
  id: string;
  name: string;
  /** image/jpeg | image/png | image/gif | image/webp */
  mime: string;
  /** Size in bytes of the original file. */
  size: number;
  /** data:image/...;base64,... — what actually goes to the API. */
  dataUrl: string;
  width?: number;
  height?: number;
}

export type MessageStatus = "streaming" | "complete" | "aborted" | "error";

export type ErrorKind =
  | "auth"
  | "balance"
  | "rate_limit"
  | "invalid_request"
  | "server"
  | "network"
  | "timeout"
  | "aborted"
  | "parse"
  | "unknown";

export interface MessageError {
  kind: ErrorKind;
  title: string;
  detail?: string;
  status?: number;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface ChatMessage {
  id: string;
  role: Role;
  content: string;
  /** Chain-of-thought returned by DeepSeek thinking mode. */
  reasoning?: string;
  images?: ImageAttachment[];
  createdAt: number;
  model?: string;
  status: MessageStatus;
  error?: MessageError | null;
  usage?: TokenUsage | null;
  /** Wall-clock time from request start to last streamed token. */
  durationMs?: number;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface AppSettings {
  /** DeepSeek thinking mode (server default is enabled/high). */
  thinkingEnabled: boolean;
  /** Render the chain-of-thought block on assistant messages. */
  showReasoning: boolean;
  /** Optional system prompt prepended to every request. */
  systemPrompt: string;
  /** Enter sends, Shift+Enter inserts a newline. */
  sendOnEnter: boolean;
  /** Keep attached images in history so follow-up turns still see them. */
  keepHistoryImages: boolean;
  /** image_url detail hint: auto | low | high | original */
  imageDetail: "auto" | "low" | "high" | "original";

  /* ── Live translation ────────────────────────────────────────────── */

  /** Which surface the app opens on. */
  lastView: AppView;
  /** auto = detect per segment; otherwise a fixed direction. */
  translateDirection: TranslateDirection;
  /** Recognition language used while direction is "auto" (Web Speech takes one). */
  speechLang: SpeechLanguage;
  /** Translate the unstable interim text too (more "live", slightly more tokens). */
  livePreview: boolean;
  /** Skip DeepSeek thinking for translations — much lower latency. */
  translateQuickMode: boolean;
  /** Remember the transcript across reloads. */
  keepTranscript: boolean;
}

export type AppView = "chat" | "translate";

export type TranslateDirection = "auto" | "zh-en" | "en-zh";

export type SpeechLanguage = "zh-CN" | "en-US" | "ja-JP" | "ko-KR";

export type LangCode = "zh" | "en" | "ja" | "ko" | "unknown";

export type SegmentStatus = "streaming" | "complete" | "error" | "aborted";

/** One recognized utterance plus its DeepSeek translation. */
export interface TranslateSegment {
  id: string;
  /** Recognized speech (Web Speech API final result). */
  source: string;
  /** Streaming DeepSeek translation. */
  translation: string;
  status: SegmentStatus;
  error?: string;
  sourceLang: LangCode;
  targetLang: LangCode;
  createdAt: number;
  durationMs?: number;
  /** True when produced from a still-unstable interim result. */
  preview?: boolean;
}

export type SpeechStatus = "idle" | "starting" | "listening" | "restarting" | "error";

export interface SpeechErrorInfo {
  code: string;
  title: string;
  detail?: string;
  hint?: string;
  /** Fatal errors stop the session; recoverable ones auto-restart. */
  fatal: boolean;
}

/** OpenAI-compatible content blocks accepted by DeepSeek Chat Completions. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: string } };

export interface ApiMessage {
  role: Role;
  content: string | ContentBlock[];
  reasoning_content?: string;
}

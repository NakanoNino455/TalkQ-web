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

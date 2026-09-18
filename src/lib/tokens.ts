import type { ChatMessage } from "@/types";
import { CONTEXT_WINDOW_TOKENS } from "./constants";
import { dataUrlBytes } from "./images";

/**
 * Rough client-side context estimation so the "1M Context" badge can show real
 * numbers. This is deliberately a heuristic (no tokenizer is downloaded), and
 * the UI labels it as an estimate.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // CJK characters are ~1 token each; latin text is ~4 chars per token.
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 4);
}

/** DeepSeek bills images by dimension with a 1024-token upper bound. */
export function estimateImageTokens(message: ChatMessage): number {
  if (!message.images?.length) return 0;
  return message.images.reduce((sum, img) => {
    // An attachment whose data URL was dropped to save quota is never resent.
    if (dataUrlBytes(img.dataUrl) === 0) return sum;
    const pixels = (img.width ?? 1300) * (img.height ?? 1300);
    const scaled = Math.min(1300 * 1300, Math.max(544 * 544, pixels));
    return sum + Math.min(1024, Math.ceil(scaled / 1650));
  }, 0);
}

export function estimateConversationTokens(messages: ChatMessage[]): number {
  return messages.reduce((sum, message) => {
    const text = `${message.content}${message.reasoning ?? ""}`;
    return sum + estimateTokens(text) + estimateImageTokens(message) + 4;
  }, 0);
}

export function contextUsedFraction(messages: ChatMessage[]): number {
  const used = estimateConversationTokens(messages);
  return Math.min(1, used / CONTEXT_WINDOW_TOKENS);
}

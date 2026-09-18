import type { ApiMessage, LangCode, TranslateDirection } from "@/types";
import {
  TRANSLATE_CONTEXT_PAIRS,
  TRANSLATE_FIRST_TOKEN_TIMEOUT_MS,
  TRANSLATE_IDLE_TIMEOUT_MS,
  TRANSLATE_SYSTEM_PROMPT,
} from "./constants";
import { streamChat, type StreamChatResult } from "./deepseek";

/**
 * Live translation on top of DeepSeek Chat Completions.
 *
 * Speech recognition happens in the browser (Web Speech API); only the
 * recognized *text* is sent here. Each utterance is one small streaming
 * request, with the previous few pairs passed as context so terminology and
 * pronouns stay consistent across sentences.
 */

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/;
const JA_KANA = /[\u3040-\u30ff]/;
const HANGUL = /[\uac00-\ud7af]/;
const LATIN = /[A-Za-z]/;

/** Cheap, instant language guess from the script — no API call needed. */
export function detectLanguage(text: string): LangCode {
  const sample = text.slice(0, 200);
  if (HANGUL.test(sample)) return "ko";
  if (JA_KANA.test(sample)) return "ja";
  if (CJK.test(sample)) return "zh";
  if (LATIN.test(sample)) return "en";
  return "unknown";
}

export interface ResolvedDirection {
  source: LangCode;
  target: LangCode;
  /** Free-text instruction appended to the system prompt. */
  instruction: string;
}

const FIXED: Record<Exclude<TranslateDirection, "auto">, { source: LangCode; target: LangCode }> = {
  "zh-en": { source: "zh", target: "en" },
  "en-zh": { source: "en", target: "zh" },
};

/**
 * Decide what to translate into.
 * - fixed directions always use their target;
 * - "auto" flips based on the language the sentence is written in.
 */
export function resolveDirection(direction: TranslateDirection, text: string): ResolvedDirection {
  if (direction !== "auto") {
    const { source, target } = FIXED[direction];
    return {
      source,
      target,
      instruction: `Translate from ${nameOf(source)} to ${nameOf(target)}.`,
    };
  }

  const detected = detectLanguage(text);
  const source: LangCode = detected === "zh" || detected === "ja" || detected === "ko" ? detected : "en";
  const target: LangCode = source === "en" ? "zh" : "en";
  return {
    source,
    target,
    instruction: `Detect the language of the input and translate it into ${nameOf(target)} (the other language).`,
  };
}

function nameOf(lang: LangCode): string {
  switch (lang) {
    case "zh":
      return "Simplified Chinese";
    case "en":
      return "English";
    case "ja":
      return "Japanese";
    case "ko":
      return "Korean";
    default:
      return "English";
  }
}

export interface TranslateContextPair {
  source: string;
  translation: string;
}

export interface TranslateParams {
  apiKey: string;
  text: string;
  direction: TranslateDirection;
  /** Recent finished pairs, oldest first. */
  context?: TranslateContextPair[];
  /** Skip thinking mode for the lowest latency. */
  quickMode: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

export interface TranslateResult {
  translation: string;
  source: LangCode;
  target: LangCode;
  aborted: boolean;
  durationMs: number;
}

export function buildTranslateMessages(
  text: string,
  direction: TranslateDirection,
  context: TranslateContextPair[] = []
): { messages: ApiMessage[]; source: LangCode; target: LangCode } {
  const resolved = resolveDirection(direction, text);

  const messages: ApiMessage[] = [
    { role: "system", content: `${TRANSLATE_SYSTEM_PROMPT} ${resolved.instruction}` },
  ];

  // Give the model a little context so names/terms stay consistent.
  for (const pair of context.slice(-TRANSLATE_CONTEXT_PAIRS)) {
    messages.push({ role: "user", content: pair.source });
    messages.push({ role: "assistant", content: pair.translation });
  }

  messages.push({ role: "user", content: text });

  return { messages, source: resolved.source, target: resolved.target };
}

/** Strip wrapping quotes/fences a model sometimes adds around a translation. */
export function cleanTranslation(raw: string): string {
  let text = raw.trim();
  text = text.replace(/^```[a-zA-Z]*\s*\n?/, "").replace(/\n?```$/, "");
  text = text.trim();
  if (text.length > 1 && /^["“「'](.*)["”」']$/s.test(text)) {
    text = text.replace(/^["“「']/, "").replace(/["”」']$/, "");
  }
  return text.trim();
}

/**
 * Render the most recent subtitles as a context block for the embedded Q&A
 * panel, so a pasted question can be answered against what was just said.
 */
export function buildTranscriptContext(
  segments: { source: string; translation: string }[],
  limit = 12
): string {
  const usable = segments
    .filter((s) => s.source.trim())
    .slice(-limit)
    .map((s) => `${s.source}${s.translation.trim() ? `\n→ ${s.translation.trim()}` : ""}`);
  if (usable.length === 0) return "";

  return [
    "【实时翻译字幕上下文】（按时间顺序，用户刚刚听到或说出的内容；如与问题无关可忽略）",
    ...usable.map((line, index) => `${index + 1}. ${line}`),
  ].join("\n");
}

export async function translateText(params: TranslateParams): Promise<TranslateResult> {
  const { messages, source, target } = buildTranslateMessages(
    params.text,
    params.direction,
    params.context
  );

  let buffer = "";
  const result: StreamChatResult = await streamChat({
    apiKey: params.apiKey,
    messages,
    signal: params.signal,
    // Thinking mode would add seconds of latency to a one-line translation.
    thinkingEnabled: !params.quickMode,
    includeUsage: false,
    firstTokenTimeoutMs: TRANSLATE_FIRST_TOKEN_TIMEOUT_MS,
    idleTimeoutMs: TRANSLATE_IDLE_TIMEOUT_MS,
    onContent: (delta) => {
      buffer += delta;
      params.onDelta?.(delta);
    },
  });

  return {
    translation: cleanTranslation(result.content || buffer),
    source,
    target,
    aborted: result.aborted,
    durationMs: result.durationMs,
  };
}

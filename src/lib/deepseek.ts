import type { ApiMessage, AppSettings, ChatMessage, ContentBlock, TokenUsage } from "@/types";
import {
  CHAT_COMPLETIONS_URL,
  DEEPSEEK_MODEL,
  DEFAULT_IMAGE_PROMPT,
  DONE_GRACE_MS,
  FIRST_TOKEN_TIMEOUT_MS,
  IDLE_TIMEOUT_MS,
} from "./constants";
import { DeepSeekError, errorFromResponse, timeoutError } from "./errors";
import { parseSseStream, type ChatCompletionChunk } from "./sse";

/**
 * The one and only DeepSeek entry point.
 *
 * Browser ──fetch()──▶ https://api.deepseek.com/chat/completions
 *
 * No proxy, no backend, no .env: the user's key travels straight from
 * localStorage to DeepSeek over TLS.
 */

export interface StreamChatParams {
  apiKey: string;
  messages: ApiMessage[];
  signal?: AbortSignal;
  thinkingEnabled?: boolean;
  onContent?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onUsage?: (usage: TokenUsage) => void;
}

export interface StreamChatResult {
  content: string;
  reasoning: string;
  finishReason: string | null;
  usage: TokenUsage | null;
  model: string;
  /** True when the user pressed "Stop generating". */
  aborted: boolean;
  durationMs: number;
}

/**
 * Convert stored chat history into DeepSeek Chat Completions messages.
 * Images are only legal on `user` messages (DeepSeek returns 400 otherwise),
 * so assistant turns are always sent as plain text.
 */
export function buildApiMessages(history: ChatMessage[], settings: AppSettings): ApiMessage[] {
  const usable = history.filter(
    (m) => m.role !== "system" && (m.content.trim().length > 0 || (m.images?.length ?? 0) > 0)
  );
  const lastUserIndex = (() => {
    for (let i = usable.length - 1; i >= 0; i -= 1) {
      if (usable[i].role === "user") return i;
    }
    return -1;
  })();

  const out: ApiMessage[] = [];
  const systemPrompt = settings.systemPrompt.trim();
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });

  usable.forEach((message, index) => {
    if (message.role === "assistant") {
      out.push({ role: "assistant", content: message.content });
      return;
    }

    const images = message.images ?? [];
    const isLatestUserTurn = index === lastUserIndex;
    const includeImages = images.length > 0 && (isLatestUserTurn || settings.keepHistoryImages);

    if (!includeImages) {
      const note =
        images.length > 0
          ? `${message.content ? `${message.content}\n` : ""}[${images.length} image(s) attached earlier — not resent]`
          : message.content;
      out.push({ role: "user", content: note.trim() || DEFAULT_IMAGE_PROMPT });
      return;
    }

    const blocks: ContentBlock[] = [
      { type: "text", text: message.content.trim() || DEFAULT_IMAGE_PROMPT },
    ];
    for (const image of images) {
      blocks.push({
        type: "image_url",
        image_url: {
          url: image.dataUrl,
          ...(settings.imageDetail !== "auto" ? { detail: settings.imageDetail } : {}),
        },
      });
    }
    out.push({ role: "user", content: blocks });
  });

  return out;
}

/** Stream a chat completion, pushing deltas through the supplied callbacks. */
export async function streamChat(params: StreamChatParams): Promise<StreamChatResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let userAborted = false;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const armWatchdog = (ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, ms);
  };

  const onExternalAbort = () => {
    userAborted = true;
    controller.abort();
  };
  if (params.signal) {
    if (params.signal.aborted) onExternalAbort();
    else params.signal.addEventListener("abort", onExternalAbort, { once: true });
  }

  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: TokenUsage | null = null;
  let model = DEEPSEEK_MODEL;
  /** Set once `data: [DONE]` arrives — the answer is complete at that point. */
  let sawDone = false;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    params.signal?.removeEventListener("abort", onExternalAbort);
  };

  try {
    armWatchdog(FIRST_TOKEN_TIMEOUT_MS);

    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
        Accept: "text/event-stream",
      },
      body: JSON.stringify(buildRequestBody(params, true)),
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await safeReadText(response);
      throw errorFromResponse(response.status, bodyText);
    }
    if (!response.body) {
      throw new DeepSeekError({
        kind: "network",
        title: "Empty Response Stream",
        detail: "api.deepseek.com returned no readable body.",
      });
    }

    armWatchdog(IDLE_TIMEOUT_MS);

    for await (const event of parseSseStream(response.body, controller.signal)) {
      armWatchdog(IDLE_TIMEOUT_MS);

      const data = event.data.trim();
      if (!data) continue;
      if (data === "[DONE]") {
        // The answer is complete. Keep reading until the server closes the
        // response instead of cancelling it (a cancelled body shows up as an
        // aborted request in devtools), but give it a short grace window so a
        // connection that stays open can never look like a failed turn.
        sawDone = true;
        armWatchdog(DONE_GRACE_MS);
        continue;
      }
      if (sawDone) continue;

      let chunk: ChatCompletionChunk;
      try {
        chunk = JSON.parse(data) as ChatCompletionChunk;
      } catch {
        // A malformed chunk should not kill an otherwise good stream.
        continue;
      }

      if (chunk.model) model = chunk.model;
      if (chunk.usage) {
        usage = chunk.usage;
        params.onUsage?.(chunk.usage);
      }

      const choice = chunk.choices?.[0];
      if (!choice) continue;

      if (choice.finish_reason) finishReason = choice.finish_reason;

      const reasoningDelta = choice.delta?.reasoning_content;
      if (reasoningDelta) {
        reasoning += reasoningDelta;
        params.onReasoning?.(reasoningDelta);
      }

      const contentDelta = choice.delta?.content;
      if (contentDelta) {
        content += contentDelta;
        params.onContent?.(contentDelta);
      }
    }

    cleanup();
    return {
      content,
      reasoning,
      finishReason,
      usage,
      model,
      aborted: false,
      durationMs: performance.now() - startedAt,
    };
  } catch (err) {
    cleanup();
    if (userAborted) {
      // Cancellation is a normal outcome, not an error banner.
      return {
        content,
        reasoning,
        finishReason,
        usage,
        model,
        aborted: true,
        durationMs: performance.now() - startedAt,
      };
    }
    if (timedOut) {
      // A completed answer is never a timeout, even if the server lingers.
      if (sawDone) {
        return {
          content,
          reasoning,
          finishReason,
          usage,
          model,
          aborted: false,
          durationMs: performance.now() - startedAt,
        };
      }
      throw timeoutError(content || reasoning ? "idle" : "connect");
    }
    if (err instanceof DeepSeekError) throw err;
    throw err;
  }
}

function buildRequestBody(
  params: Pick<StreamChatParams, "messages" | "thinkingEnabled">,
  stream: boolean,
  includeUsage = true
) {
  const body: Record<string, unknown> = {
    model: DEEPSEEK_MODEL,
    messages: params.messages,
    stream,
  };
  if (stream && includeUsage) {
    body.stream_options = { include_usage: true };
  }
  if (params.thinkingEnabled === false) {
    body.thinking = { type: "disabled" };
  }
  return body;
}

async function safeReadText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

export interface TestConnectionResult {
  ok: true;
  model: string;
  latencyMs: number;
  reply: string;
}

/**
 * "Test Connection": send the smallest possible request and translate every
 * failure mode into a specific, human-readable reason.
 */
export async function testConnection(apiKey: string, signal?: AbortSignal): Promise<TestConnectionResult> {
  const startedAt = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, 30_000);

  const onExternalAbort = () => controller.abort();
  signal?.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const response = await fetch(CHAT_COMPLETIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: DEEPSEEK_MODEL,
        messages: [{ role: "user", content: "Hello" }],
        stream: false,
        max_tokens: 16,
        thinking: { type: "disabled" },
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      throw errorFromResponse(response.status, await safeReadText(response));
    }

    const payload = (await response.json().catch(() => null)) as {
      model?: string;
      choices?: Array<{ message?: { content?: string } }>;
    } | null;

    if (!payload) {
      throw new DeepSeekError({
        kind: "parse",
        title: "Could Not Parse DeepSeek Response",
        detail: "The connection test returned a body that was not valid JSON.",
      });
    }

    return {
      ok: true,
      model: payload.model ?? DEEPSEEK_MODEL,
      latencyMs: performance.now() - startedAt,
      reply: payload.choices?.[0]?.message?.content?.trim() ?? "",
    };
  } catch (err) {
    if (timedOut) throw timeoutError("connect");
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }
}

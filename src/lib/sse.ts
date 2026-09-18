/**
 * Minimal, dependency-free SSE reader over a fetch ReadableStream.
 *
 * Handles the parts that actually break naive implementations:
 *  - chunks split mid-line / mid-event (buffering across reads)
 *  - CRLF, LF and CR line endings
 *  - multi-line `data:` payloads joined with \n per the SSE spec
 *  - comment lines (`: keep-alive`) and `event:` / `id:` fields
 *  - the terminal `data: [DONE]` sentinel DeepSeek sends
 */

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<SseEvent, void, void> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Normalise CRLF / CR so a single split rule works.
      buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const rawEvent = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseEventBlock(rawEvent);
        if (parsed) yield parsed;
        boundary = buffer.indexOf("\n\n");
      }
    }

    // Flush a trailing event that arrived without the final blank line.
    buffer += decoder.decode();
    buffer = buffer.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const tail = parseEventBlock(buffer);
    if (tail) yield tail;
  } finally {
    // Cancel the stream so the socket is released when the consumer stops early.
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}

function parseEventBlock(block: string): SseEvent | null {
  if (!block.trim()) return null;

  let event: string | undefined;
  const dataLines: string[] = [];

  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / keep-alive
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);

    if (field === "data") dataLines.push(value);
    else if (field === "event") event = value;
    // `id` / `retry` are irrelevant for chat completions.
  }

  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

/** DeepSeek (OpenAI-compatible) streaming chunk shape. */
export interface ChatCompletionChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  } | null;
}

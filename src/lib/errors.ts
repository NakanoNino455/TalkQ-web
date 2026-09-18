import type { ErrorKind, MessageError } from "@/types";

/**
 * DeepSeek error taxonomy. Every failure path funnels through here so the UI
 * can show a *specific* reason ("Insufficient DeepSeek Balance") instead of a
 * generic "Request failed".
 *
 * Reference: https://api-docs.deepseek.com/quick_start/error_codes
 */

export class DeepSeekError extends Error {
  kind: ErrorKind;
  status?: number;
  detail?: string;
  hint?: string;

  constructor(opts: {
    kind: ErrorKind;
    title: string;
    detail?: string;
    status?: number;
    hint?: string;
  }) {
    super(opts.title);
    this.name = "DeepSeekError";
    this.kind = opts.kind;
    this.status = opts.status;
    this.detail = opts.detail;
    this.hint = opts.hint;
  }

  toMessageError(): MessageError {
    return {
      kind: this.kind,
      title: this.message,
      detail: this.detail,
      status: this.status,
    };
  }
}

const TITLES: Record<ErrorKind, string> = {
  auth: "Invalid DeepSeek API Key",
  balance: "Insufficient DeepSeek Balance",
  rate_limit: "Rate Limit Reached",
  invalid_request: "Invalid Request",
  server: "DeepSeek Server Error",
  network: "Network Error",
  timeout: "Request Timed Out",
  aborted: "Generation Stopped",
  parse: "Could Not Parse DeepSeek Response",
  unknown: "Request Failed",
};

const HINTS: Partial<Record<ErrorKind, string>> = {
  auth: "Check the key in Settings — it must start with sk- and belong to an active DeepSeek account.",
  balance: "Top up your balance at platform.deepseek.com/top_up, then try again.",
  rate_limit: "You are sending requests too quickly. Wait a moment and resend.",
  server: "DeepSeek is having trouble on their side. Retrying usually works.",
  network:
    "The browser could not reach api.deepseek.com. Check your connection, VPN, or an extension blocking the request.",
  timeout: "The stream stalled and was cancelled. Try again or lower the input size.",
  parse: "The streaming payload was not valid SSE/JSON. Try regenerating the answer.",
};

export function titleForKind(kind: ErrorKind): string {
  return TITLES[kind];
}

export function kindForStatus(status: number, apiCode?: string, apiMessage?: string): ErrorKind {
  const text = `${apiCode ?? ""} ${apiMessage ?? ""}`.toLowerCase();
  if (status === 401 || status === 403) return "auth";
  if (status === 402) return "balance";
  if (status === 429) return "rate_limit";
  if (status === 400 || status === 404 || status === 422) {
    if (text.includes("api key") || text.includes("authentication")) return "auth";
    if (text.includes("insufficient") || text.includes("balance")) return "balance";
    return "invalid_request";
  }
  if (status >= 500) return "server";
  return "unknown";
}

interface ApiErrorBody {
  error?: { message?: string; type?: string; code?: string; param?: string | null };
  message?: string;
}

/** Build a typed error from a non-2xx HTTP response. */
export function errorFromResponse(status: number, bodyText: string): DeepSeekError {
  let parsed: ApiErrorBody | null = null;
  try {
    parsed = bodyText ? (JSON.parse(bodyText) as ApiErrorBody) : null;
  } catch {
    parsed = null;
  }
  const apiMessage = parsed?.error?.message ?? parsed?.message ?? bodyText?.slice(0, 400);
  const apiCode = parsed?.error?.code ?? parsed?.error?.type;
  const kind = kindForStatus(status, apiCode, apiMessage);

  const detailParts: string[] = [];
  if (apiMessage) detailParts.push(apiMessage);
  if (apiCode && apiCode !== apiMessage) detailParts.push(`code: ${apiCode}`);

  return new DeepSeekError({
    kind,
    title: TITLES[kind],
    detail: detailParts.join(" · ") || `HTTP ${status}`,
    status,
    hint: HINTS[kind],
  });
}

/** Normalise anything thrown by fetch / the stream reader into a DeepSeekError. */
export function toDeepSeekError(err: unknown): DeepSeekError {
  if (err instanceof DeepSeekError) return err;

  if (isAbortError(err)) {
    return new DeepSeekError({
      kind: "aborted",
      title: TITLES.aborted,
      detail: "The request was cancelled by the user.",
    });
  }

  if (err instanceof SyntaxError) {
    return new DeepSeekError({
      kind: "parse",
      title: TITLES.parse,
      detail: err.message,
      hint: HINTS.parse,
    });
  }

  if (err instanceof TypeError) {
    // fetch rejects with TypeError for DNS/CORS/offline failures.
    return new DeepSeekError({
      kind: "network",
      title: TITLES.network,
      detail: err.message || "Failed to fetch",
      hint: HINTS.network,
    });
  }

  const message = err instanceof Error ? err.message : String(err);
  return new DeepSeekError({
    kind: "unknown",
    title: TITLES.unknown,
    detail: message,
  });
}

export function isAbortError(err: unknown): boolean {
  return (
    !!err &&
    typeof err === "object" &&
    ((err as { name?: string }).name === "AbortError" ||
      (err as { name?: string }).name === "TimeoutError")
  );
}

export function timeoutError(phase: "connect" | "idle"): DeepSeekError {
  return new DeepSeekError({
    kind: "timeout",
    title: TITLES.timeout,
    detail:
      phase === "connect"
        ? "No response headers arrived from api.deepseek.com in time."
        : "The response stream stopped sending data.",
    hint: HINTS.timeout,
  });
}

/** True when retrying the exact same request could plausibly succeed. */
export function isRetryable(kind: ErrorKind): boolean {
  return kind === "server" || kind === "rate_limit" || kind === "network" || kind === "timeout";
}

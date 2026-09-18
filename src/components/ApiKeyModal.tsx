import { useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Eye, EyeOff, KeyRound, Loader2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Logo } from "@/components/Logo";
import { DEEPSEEK_BASE_URL, MODEL_LABEL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { showToast } from "@/stores/toastStore";

/**
 * First-run gate. Shown whenever `talkq_deepseek_api_key` is missing from
 * localStorage; "Test & Continue" verifies the key against DeepSeek before the
 * chat UI is unlocked.
 */
export function ApiKeyModal({
  mode = "first-run",
  onDone,
  onCancel,
}: {
  mode?: "first-run" | "change";
  onDone: () => void;
  onCancel?: () => void;
}) {
  const storedKey = useSettingsStore((s) => s.apiKey);
  const connection = useSettingsStore((s) => s.connection);
  const connectionError = useSettingsStore((s) => s.connectionError);
  const runConnectionTest = useSettingsStore((s) => s.runConnectionTest);
  const setApiKey = useSettingsStore((s) => s.setApiKey);

  const [value, setValue] = useState(mode === "change" ? (storedKey ?? "") : "");
  const [revealed, setRevealed] = useState(false);
  const [failedOnce, setFailedOnce] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && mode === "change") onCancel?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, onCancel]);

  const trimmed = value.trim();
  const testing = connection === "testing";
  const canSubmit = trimmed.length >= 8 && !testing;

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!canSubmit) return;
    const ok = await runConnectionTest(trimmed);
    if (ok) {
      setApiKey(trimmed);
      showToast("success", "Connection successful", `${MODEL_LABEL} is ready — streaming replies.`);
      onDone();
    } else {
      setFailedOnce(true);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-background/85 backdrop-blur-md" aria-hidden />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="nexq-api-key-title"
        className="dash-modal relative w-full max-w-[26rem] overflow-hidden rounded-2xl border border-border bg-card/95 shadow-2xl backdrop-blur-xl"
      >
        {/* Ambient top light, matching the TalkQ modal treatment */}
        <div
          className="pointer-events-none absolute inset-x-0 -top-24 h-40 bg-[radial-gradient(28rem_10rem_at_50%_100%,hsl(var(--primary)/0.18),transparent_70%)]"
          aria-hidden
        />

        <div className="relative flex flex-col items-center px-6 pb-6 pt-7">
          <Logo withWordmark={false} size={44} />
          <h1
            id="nexq-api-key-title"
            className="mt-3 text-lg font-semibold tracking-tight text-foreground"
          >
            TalkQ
          </h1>
          <p className="mt-1 text-xs text-muted-foreground">
            {mode === "change" ? "Update your DeepSeek key" : "Connect your DeepSeek"}
          </p>

          <form onSubmit={handleSubmit} className="mt-6 w-full">
            <label
              htmlFor="nexq-api-key"
              className="mb-1.5 block text-meta uppercase tracking-[0.16em] text-muted-foreground"
            >
              API Key
            </label>

            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                <KeyRound className="h-3.5 w-3.5" />
              </span>
              <input
                id="nexq-api-key"
                ref={inputRef}
                type={revealed ? "text" : "password"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder="sk-••••••••••••••••"
                autoComplete="off"
                spellCheck={false}
                className={cn(
                  "h-11 w-full rounded-lg border bg-background/70 pl-9 pr-16 font-mono text-[13px] text-foreground",
                  "placeholder:text-muted-foreground/60 focus:outline-none focus:ring-0",
                  connectionError && connection === "error"
                    ? "border-destructive/60"
                    : "border-input focus:border-primary/60"
                )}
              />
              <button
                type="button"
                onClick={() => setRevealed((v) => !v)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                aria-label={revealed ? "Hide API key" : "Show API key"}
                title={revealed ? "Hide key" : "Show key"}
              >
                {revealed ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </button>
            </div>

            {/* Specific failure reason — never a bare "Request failed". */}
            {connection === "error" && connectionError && (
              <div className="slide-up mt-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-destructive">{connectionError.title}</p>
                    {connectionError.detail && (
                      <p className="mt-0.5 break-words text-[11px] leading-snug text-destructive/80">
                        {connectionError.detail}
                      </p>
                    )}
                  </div>
                </div>
              </div>
            )}

            {connection === "ok" && (
              <div className="slide-up mt-3 flex items-center gap-2 rounded-lg border border-success/40 bg-success/10 px-3 py-2.5">
                <CheckCircle2 className="h-3.5 w-3.5 text-success" />
                <p className="text-xs font-medium text-success">Connection successful</p>
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="mt-4 w-full"
              disabled={!canSubmit}
            >
              {testing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Testing connection…
                </>
              ) : (
                "Test & Continue"
              )}
            </Button>

            {failedOnce && connection === "error" && (
              <button
                type="button"
                onClick={() => {
                  setApiKey(trimmed);
                  showToast("info", "Key saved without testing");
                  onDone();
                }}
                className="mt-2 w-full text-center text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
              >
                Save anyway and start chatting
              </button>
            )}

            {mode === "change" && (
              <button
                type="button"
                onClick={onCancel}
                className="mt-2 w-full text-center text-[11px] text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            )}
          </form>

          <div className="mt-5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <ShieldCheck className="h-3 w-3 text-success/80" />
            <span>
              Stored locally in your browser · sent only to{" "}
              <span className="font-mono">{DEEPSEEK_BASE_URL.replace("https://", "")}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

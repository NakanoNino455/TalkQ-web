import { useEffect } from "react";
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  Database,
  Gauge,
  Images,
  Info,
  KeyRound,
  Loader2,
  Mic,
  PlugZap,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  CONTEXT_WINDOW_LABEL,
  CONTEXT_WINDOW_TOKENS,
  DEEPSEEK_BASE_URL,
  DEEPSEEK_MODEL,
  IMAGE_LIMITS,
  MAX_OUTPUT_TOKENS_LABEL,
  MODEL_VERSION_LABEL,
  SPEECH_LANGUAGES,
  STORAGE_KEYS,
  TRANSLATE_DIRECTIONS,
} from "@/lib/constants";
import { eraseAllLocalData } from "@/lib/storage";
import { cn, formatCompact, formatDuration } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { showToast } from "@/stores/toastStore";

function maskKey(key: string): string {
  const tail = key.slice(-4);
  return `sk-${"•".repeat(12)}${tail}`;
}

/** Right-hand settings drawer. Model/provider is fixed to DeepSeek Flash. */
export function SettingsPanel({
  open,
  onClose,
  onChangeKey,
}: {
  open: boolean;
  onClose: () => void;
  onChangeKey: () => void;
}) {
  const apiKey = useSettingsStore((s) => s.apiKey);
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const connection = useSettingsStore((s) => s.connection);
  const connectionInfo = useSettingsStore((s) => s.connectionInfo);
  const connectionError = useSettingsStore((s) => s.connectionError);
  const runConnectionTest = useSettingsStore((s) => s.runConnectionTest);
  const clearApiKey = useSettingsStore((s) => s.clearApiKey);
  const resetSettings = useSettingsStore((s) => s.resetSettings);
  const clearAllChats = useChatStore((s) => s.clearAllChats);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-background/60 backdrop-blur-sm" onClick={onClose} aria-hidden />

      <aside
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="settings-content-enter relative flex h-full w-full max-w-[27rem] flex-col border-l border-border bg-card/95 backdrop-blur-xl"
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3.5">
          <h2 className="text-sm font-semibold text-foreground">Settings</h2>
          <span className="ml-auto text-meta uppercase tracking-[0.16em] text-muted-foreground">
            NexQ Web
          </span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close settings"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
          {/* ── DeepSeek API ── */}
          <Section icon={<PlugZap className="h-3.5 w-3.5" />} title="DeepSeek API">
            <Row label="Endpoint">
              <span className="font-mono text-[11px] text-muted-foreground">
                {DEEPSEEK_BASE_URL.replace("https://", "")}
              </span>
            </Row>

            <Row label="API Key">
              <span className="font-mono text-[11px] text-foreground">
                {apiKey ? maskKey(apiKey) : "not set"}
              </span>
            </Row>

            <div className="mt-2 flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" className="gap-1.5" onClick={onChangeKey}>
                <KeyRound className="h-3 w-3" />
                Change API Key
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                disabled={!apiKey || connection === "testing"}
                onClick={() => void runConnectionTest()}
              >
                {connection === "testing" ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <PlugZap className="h-3 w-3" />
                )}
                Test Connection
              </Button>
              {apiKey && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground hover:text-destructive"
                  onClick={() => {
                    clearApiKey();
                    showToast("info", "API key removed from this browser");
                  }}
                >
                  <Trash2 className="h-3 w-3" />
                  Remove key
                </Button>
              )}
            </div>

            {connection === "ok" && connectionInfo && (
              <div className="slide-up mt-2.5 flex items-start gap-2 rounded-lg border border-success/40 bg-success/10 px-2.5 py-2">
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-success" />
                <div>
                  <p className="text-[11px] font-medium text-success">Connection successful</p>
                  <p className="mt-0.5 text-meta text-success/85">
                    {connectionInfo.model} · {formatDuration(connectionInfo.latencyMs)}
                    {connectionInfo.reply ? ` · "${connectionInfo.reply.slice(0, 24)}"` : ""}
                  </p>
                </div>
              </div>
            )}

            {connection === "error" && connectionError && (
              <div className="slide-up mt-2.5 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <div className="min-w-0">
                  <p className="text-[11px] font-medium text-destructive">
                    {connectionError.title}
                  </p>
                  {connectionError.detail && (
                    <p className="mt-0.5 break-words font-mono text-meta text-destructive/85">
                      {connectionError.detail}
                    </p>
                  )}
                </div>
              </div>
            )}
          </Section>

          {/* ── Model / context / images (fixed facts, no provider selector) ── */}
          <Section icon={<Cpu className="h-3.5 w-3.5" />} title="Model">
            <Row label="Model">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-foreground">
                <Sparkles className="h-3 w-3 text-primary" />
                {MODEL_VERSION_LABEL}
              </span>
            </Row>
            <Row label="API name">
              <span className="font-mono text-[11px] text-muted-foreground">{DEEPSEEK_MODEL}</span>
            </Row>
            <Row label="Context">
              <span className="text-[11px] text-foreground">
                {CONTEXT_WINDOW_LABEL} · {formatCompact(CONTEXT_WINDOW_TOKENS)} tokens
              </span>
            </Row>
            <Row label="Max output">
              <span className="text-[11px] text-muted-foreground">{MAX_OUTPUT_TOKENS_LABEL}</span>
            </Row>
            <Row label="Images">
              <span className="inline-flex items-center gap-1.5 text-[11px] text-success">
                <Images className="h-3 w-3" />
                Supported · {IMAGE_LIMITS.formatLabels}
              </span>
            </Row>
            <p className="mt-2 text-meta leading-relaxed text-muted-foreground">
              DeepSeek Flash has no legacy 4K/8K/32K/128K clamp — the full conversation history is
              sent on every turn.
            </p>
          </Section>

          {/* ── Generation ── */}
          <Section icon={<Brain className="h-3.5 w-3.5" />} title="Generation">
            <Toggle
              label="Thinking mode"
              hint="DeepSeek reasons before answering (reasoning_content)"
              checked={settings.thinkingEnabled}
              onChange={(v) => updateSettings({ thinkingEnabled: v })}
            />
            <Toggle
              label="Show reasoning"
              hint="Display the collapsible thought process"
              checked={settings.showReasoning}
              onChange={(v) => updateSettings({ showReasoning: v })}
            />
            <Toggle
              label="Keep images in history"
              hint="Follow-up questions can still see earlier screenshots"
              checked={settings.keepHistoryImages}
              onChange={(v) => updateSettings({ keepHistoryImages: v })}
            />
            <Toggle
              label="Enter sends"
              hint={settings.sendOnEnter ? "Shift+Enter for a newline" : "Ctrl+Enter sends"}
              checked={settings.sendOnEnter}
              onChange={(v) => updateSettings({ sendOnEnter: v })}
            />

            <div className="mt-2.5">
              <label className="text-meta uppercase tracking-[0.16em] text-muted-foreground">
                Image detail
              </label>
              <select
                value={settings.imageDetail}
                onChange={(e) =>
                  updateSettings({ imageDetail: e.target.value as typeof settings.imageDetail })
                }
                className="mt-1.5 h-8 w-full rounded-md border border-border bg-background/60 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
              >
                <option value="auto">auto (matches DeepSeek default)</option>
                <option value="low">low (512×512, cheaper)</option>
                <option value="high">high (original pixels)</option>
                <option value="original">original</option>
              </select>
            </div>
          </Section>

          {/* ── Live translation ── */}
          <Section icon={<Mic className="h-3.5 w-3.5" />} title="实时翻译">
            <div className="mt-1">
              <label className="text-meta uppercase tracking-[0.16em] text-muted-foreground">
                Translation direction
              </label>
              <select
                value={settings.translateDirection}
                onChange={(e) =>
                  updateSettings({
                    translateDirection: e.target.value as typeof settings.translateDirection,
                  })
                }
                className="mt-1.5 h-8 w-full rounded-md border border-border bg-background/60 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
              >
                {TRANSLATE_DIRECTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label} — {option.hint}
                  </option>
                ))}
              </select>
            </div>

            <div className="mt-2.5">
              <label className="text-meta uppercase tracking-[0.16em] text-muted-foreground">
                Recognition language
              </label>
              <select
                value={settings.speechLang}
                disabled={settings.translateDirection !== "auto"}
                onChange={(e) =>
                  updateSettings({ speechLang: e.target.value as typeof settings.speechLang })
                }
                className="mt-1.5 h-8 w-full rounded-md border border-border bg-background/60 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-60"
              >
                {SPEECH_LANGUAGES.map((lang) => (
                  <option key={lang.value} value={lang.value}>
                    {lang.label}
                  </option>
                ))}
              </select>
              {settings.translateDirection !== "auto" && (
                <p className="mt-1 text-meta text-muted-foreground">
                  固定方向时识别语言会自动跟随方向。
                </p>
              )}
            </div>

            <div className="mt-1.5">
              <Toggle
                label="实时预览译文"
                hint="说话过程中就先流式给出预览翻译（略多消耗 token）"
                checked={settings.livePreview}
                onChange={(v) => updateSettings({ livePreview: v })}
              />
              <Toggle
                label="低延迟模式"
                hint="翻译时关闭 DeepSeek 思考模式，首字更快"
                checked={settings.translateQuickMode}
                onChange={(v) => updateSettings({ translateQuickMode: v })}
              />
              <Toggle
                label="保留翻译记录"
                hint="字幕保存在本机 localStorage，刷新后仍在"
                checked={settings.keepTranscript}
                onChange={(v) => updateSettings({ keepTranscript: v })}
              />
            </div>

            <p className="mt-2 text-meta leading-relaxed text-muted-foreground">
              语音识别由浏览器内置能力（Web Speech API）完成，仅 Chrome / Edge 支持；
              Chrome 会把音频发送到 Google 的语音服务。发往 DeepSeek 的只有识别出的文字。
            </p>
          </Section>

          {/* ── Chat behaviour ── */}
          <Section icon={<Gauge className="h-3.5 w-3.5" />} title="Chat">
            <label className="text-meta uppercase tracking-[0.16em] text-muted-foreground">
              System prompt (optional)
            </label>
            <textarea
              value={settings.systemPrompt}
              onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
              rows={3}
              placeholder="e.g. Always answer in Chinese, be concise."
              className="mt-1.5 w-full resize-y rounded-md border border-border bg-background/60 px-2.5 py-2 text-[12px] leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:border-primary/50 focus:outline-none"
            />
          </Section>

          {/* ── Local data ── */}
          <Section icon={<Database className="h-3.5 w-3.5" />} title="Local data">
            <ul className="space-y-1 text-meta text-muted-foreground">
              <li className="font-mono">{STORAGE_KEYS.apiKey}</li>
              <li className="font-mono">{STORAGE_KEYS.settings}</li>
              <li className="font-mono">{STORAGE_KEYS.chatHistory}</li>
              <li className="font-mono">{STORAGE_KEYS.transcript}</li>
            </ul>
            <div className="mt-2.5 flex flex-wrap gap-2">
              <Button
                variant="secondary"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  if (window.confirm("Delete all conversations stored in this browser?"))
                    clearAllChats();
                }}
              >
                <Trash2 className="h-3 w-3" />
                Clear chat history
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground"
                onClick={() => {
                  resetSettings();
                  showToast("info", "Settings restored to defaults");
                }}
              >
                Reset settings
              </Button>
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => {
                  if (
                    window.confirm(
                      "Erase the API key, settings and all chats from this browser? This cannot be undone."
                    )
                  ) {
                    eraseAllLocalData();
                    clearAllChats();
                    resetSettings();
                    clearApiKey();
                    showToast("info", "Local data erased");
                    onClose();
                  }
                }}
              >
                <Trash2 className="h-3 w-3" />
                Erase local data
              </Button>
            </div>
          </Section>

          {/* ── About ── */}
          <Section icon={<Info className="h-3.5 w-3.5" />} title="About">
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              NexQ Web is a static, browser-only DeepSeek client. There is no Tauri shell, no Rust,
              no Node backend, no proxy and no telemetry: the bundle you loaded is the whole app.
            </p>
            <p className="mt-2 text-meta leading-relaxed text-muted-foreground">
              The only network destination is{" "}
              <span className="font-mono text-foreground/80">{DEEPSEEK_BASE_URL}</span>. Your key is
              kept in <span className="font-mono">localStorage</span> and sent only in the
              Authorization header of your own requests.
            </p>
          </Section>
        </div>
      </aside>
    </div>
  );
}

function Section({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-xl border border-border bg-background/40 p-3.5">
      <h3 className="mb-2.5 flex items-center gap-1.5 text-meta uppercase tracking-[0.16em] text-muted-foreground">
        <span className="text-primary/70">{icon}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-[11px] text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <div className="min-w-0">
        <p className="text-[12px] text-foreground">{label}</p>
        {hint && <p className="mt-0.5 text-meta leading-snug text-muted-foreground">{hint}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        data-checked={checked}
        onClick={() => onChange(!checked)}
        className={cn("toggle-switch mt-0.5 shrink-0")}
      />
    </div>
  );
}

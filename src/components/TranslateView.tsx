import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowDown,
  ClipboardCopy,
  Mic,
  MicOff,
  Radio,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Square,
  Timer,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MicMeter } from "./MicMeter";
import { SegmentCard } from "./SegmentCard";
import {
  LANG_LABELS,
  SPEECH_LANGUAGES,
  TRANSLATE_DIRECTIONS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { describeEnvironmentProblem, isSpeechRecognitionSupported } from "@/lib/speech";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";
import { showToast } from "@/stores/toastStore";

/**
 * Live translation surface: press start → the browser asks for the
 * microphone → speech is recognized locally and each finished utterance is
 * streamed through DeepSeek Flash as a bilingual subtitle.
 */
export function TranslateView() {
  const status = useTranslateStore((s) => s.status);
  const interim = useTranslateStore((s) => s.interim);
  const interimTranslation = useTranslateStore((s) => s.interimTranslation);
  const interimSourceLang = useTranslateStore((s) => s.interimSourceLang);
  const interimTargetLang = useTranslateStore((s) => s.interimTargetLang);
  const segments = useTranslateStore((s) => s.segments);
  const error = useTranslateStore((s) => s.error);
  const micLevel = useTranslateStore((s) => s.micLevel);
  const startedAt = useTranslateStore((s) => s.startedAt);
  const toggle = useTranslateStore((s) => s.toggle);
  const clear = useTranslateStore((s) => s.clear);
  const setLanguage = useTranslateStore((s) => s.setLanguage);
  const retranslate = useTranslateStore((s) => s.retranslate);
  const copyAll = useTranslateStore((s) => s.copyAll);

  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  const [elapsed, setElapsed] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const environmentProblem = useMemo(() => describeEnvironmentProblem(), []);

  const listening = status === "listening" || status === "starting" || status === "restarting";

  useEffect(() => {
    if (!startedAt) {
      setElapsed(0);
      return;
    }
    const id = setInterval(() => setElapsed(Date.now() - startedAt), 1000);
    setElapsed(Date.now() - startedAt);
    return () => clearInterval(id);
  }, [startedAt]);

  useEffect(() => {
    if (!pinned || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [segments, interim, interimTranslation, pinned]);

  const handleDelete = (id: string) => {
    useTranslateStore.setState((state) => ({
      segments: state.segments.filter((s) => s.id !== id),
    }));
  };

  const statusLabel =
    status === "listening"
      ? "正在聆听"
      : status === "starting"
        ? "正在启动…"
        : status === "restarting"
          ? "正在重连识别…"
          : status === "error"
            ? "已停止"
            : "未开始";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* ── Control bar ─────────────────────────────────────────────── */}
      <div className="dash-header shrink-0 border-b border-border bg-background/40 px-3 py-3 backdrop-blur-xl sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={listening ? "destructive" : "primary"}
              size="lg"
              className="gap-2"
              onClick={() => void toggle()}
            >
              {listening ? (
                <>
                  <Square className="h-4 w-4" />
                  停止翻译
                </>
              ) : (
                <>
                  <Mic className="h-4 w-4" />
                  开始实时翻译
                </>
              )}
            </Button>

            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
                status === "listening"
                  ? "border-success/40 bg-success/10 text-success"
                  : status === "error"
                    ? "border-destructive/40 bg-destructive/10 text-destructive"
                    : "border-border bg-muted/40 text-muted-foreground"
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  status === "listening" ? "bg-success live-ring-pulse" : "bg-current opacity-60"
                )}
              />
              {statusLabel}
            </span>

            {startedAt && (
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
                <Timer className="h-3 w-3" />
                {formatElapsed(elapsed)}
              </span>
            )}

            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
              <Radio className="h-3 w-3" />
              {segments.length} 句
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                disabled={segments.length === 0}
                onClick={async () => {
                  const ok = await copyAll();
                  showToast(ok ? "success" : "error", ok ? "已复制全部字幕" : "复制失败");
                }}
              >
                <ClipboardCopy className="h-3.5 w-3.5" />
                复制全部
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5"
                disabled={segments.length === 0}
                onClick={() => {
                  const text = useTranslateStore.getState().exportTranscript();
                  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url;
                  a.download = `nexq-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
                  a.click();
                  URL.revokeObjectURL(url);
                }}
              >
                <ArrowDownToLine className="h-3.5 w-3.5" />
                导出
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="gap-1.5 text-muted-foreground hover:text-destructive"
                disabled={segments.length === 0}
                onClick={() => {
                  if (window.confirm("清空本次翻译记录？")) clear();
                }}
              >
                <Trash2 className="h-3.5 w-3.5" />
                清空
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {/* Direction switch — freely changeable at any time */}
            <div className="inline-flex items-center gap-1 rounded-lg border border-border bg-background/60 p-0.5">
              {TRANSLATE_DIRECTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  title={option.hint}
                  onClick={() => updateSettings({ translateDirection: option.value })}
                  className={cn(
                    "rounded-md px-2.5 py-1 text-[11px] transition-colors",
                    settings.translateDirection === option.value
                      ? "bg-primary/15 text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  {option.label}
                </button>
              ))}
            </div>

            <span className="text-meta text-muted-foreground/70">识别语言</span>
            <select
              value={
                settings.translateDirection === "zh-en"
                  ? "zh-CN"
                  : settings.translateDirection === "en-zh"
                    ? "en-US"
                    : settings.speechLang
              }
              disabled={settings.translateDirection !== "auto"}
              onChange={(e) => {
                updateSettings({ speechLang: e.target.value as typeof settings.speechLang });
                setLanguage(e.target.value);
              }}
              className="h-7 rounded-md border border-border bg-background/60 px-2 text-[11px] text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-60"
            >
              {SPEECH_LANGUAGES.map((lang) => (
                <option key={lang.value} value={lang.value}>
                  {lang.label}
                </option>
              ))}
            </select>

            <button
              type="button"
              onClick={() => updateSettings({ livePreview: !settings.livePreview })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                settings.livePreview
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
              )}
              title="说话过程中就先给出预览译文"
            >
              <Sparkles className="h-3 w-3" />
              实时预览
            </button>

            <button
              type="button"
              onClick={() => updateSettings({ translateQuickMode: !settings.translateQuickMode })}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors",
                settings.translateQuickMode
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : "border-border bg-muted/40 text-muted-foreground hover:text-foreground"
              )}
              title="关闭 DeepSeek 思考模式，翻译延迟更低"
            >
              <ArrowDown className="h-3 w-3" />
              低延迟
            </button>
          </div>

          <MicMeter level={micLevel} active={status === "listening"} />
        </div>
      </div>

      {/* ── Environment / error banners ─────────────────────────────── */}
      {environmentProblem && (
        <Banner tone="warning" icon={<ShieldAlert className="h-3.5 w-3.5" />} title={environmentProblem.title}>
          {environmentProblem.detail}
        </Banner>
      )}

      {error && !environmentProblem && (
        <Banner
          tone="error"
          icon={<AlertTriangle className="h-3.5 w-3.5" />}
          title={error.title}
          action={
            error.fatal ? (
              <Button
                variant="destructive"
                size="sm"
                className="gap-1.5"
                onClick={() => void useTranslateStore.getState().start()}
              >
                <RefreshCw className="h-3 w-3" />
                重试（检查权限后）
              </Button>
            ) : undefined
          }
        >
          {error.detail}
          {error.hint && <span className="mt-0.5 block opacity-80">{error.hint}</span>}
        </Banner>
      )}

      {/* ── Subtitle stream ─────────────────────────────────────────── */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current;
            if (!el) return;
            setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
          }}
          className="h-full overflow-y-auto px-3 py-4 sm:px-6"
        >
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-2.5">
            {segments.length === 0 && !interim ? (
              <EmptyTranscript
                listening={listening}
                supported={isSpeechRecognitionSupported()}
                onStart={() => void toggle()}
              />
            ) : (
              segments.map((segment, index) => (
                <SegmentCard
                  key={segment.id}
                  segment={segment}
                  index={index}
                  onRetranslate={(id) => void retranslate(id)}
                  onDelete={handleDelete}
                />
              ))
            )}

            {/* Live interim text + its preview translation */}
            {interim && (
              <div className="rounded-xl border border-primary/25 bg-primary/[0.06] px-3.5 py-3">
                <div className="mb-1.5 flex items-center gap-2 text-meta text-primary/80">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  正在识别…
                </div>
                <p className="text-[12.5px] italic leading-relaxed text-muted-foreground">{interim}</p>
                {interimTranslation ? (
                  <p className="mt-1.5 text-[15px] leading-relaxed text-foreground/85">
                    {interimTranslation}
                    <span className="ml-2 align-middle font-mono text-meta text-muted-foreground/60">
                      {LANG_LABELS[interimSourceLang]} → {LANG_LABELS[interimTargetLang]} 预览
                    </span>
                  </p>
                ) : (
                  settings.livePreview && (
                    <p className="mt-1.5 text-[12px] text-muted-foreground/60">预览翻译中…</p>
                  )
                )}
              </div>
            )}

            <div className="h-2" />
          </div>
        </div>

        {!pinned && segments.length > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              const el = scrollRef.current;
              if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
              setPinned(true);
            }}
            className="absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 rounded-full shadow-lg"
          >
            <ArrowDown className="h-3 w-3" />
            回到最新
          </Button>
        )}
      </div>
    </div>
  );
}

function Banner({
  tone,
  icon,
  title,
  children,
  action,
}: {
  tone: "warning" | "error";
  icon: React.ReactNode;
  title: string;
  children?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "shrink-0 border-b px-3 py-2.5 sm:px-6",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10"
          : "border-warning/30 bg-warning/10"
      )}
    >
      <div className="mx-auto flex w-full max-w-3xl items-start gap-2">
        <span className={tone === "error" ? "mt-0.5 text-destructive" : "mt-0.5 text-warning"}>{icon}</span>
        <div className="min-w-0 flex-1">
          <p className={cn("text-xs font-medium", tone === "error" ? "text-destructive" : "text-warning")}>
            {title}
          </p>
          {children && (
            <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{children}</p>
          )}
        </div>
        {action}
      </div>
    </div>
  );
}

function EmptyTranscript({
  listening,
  supported,
  onStart,
}: {
  listening: boolean;
  supported: boolean;
  onStart: () => void;
}) {
  return (
    <div className="fade-in flex flex-col items-center pt-8 text-center sm:pt-14">
      <button
        type="button"
        onClick={onStart}
        disabled={!supported}
        className={cn(
          "grid h-20 w-20 place-items-center rounded-3xl border transition-all duration-300",
          listening
            ? "border-primary/50 bg-primary/15 glow-primary-strong"
            : "border-border bg-card/60 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card/90",
          !supported && "cursor-not-allowed opacity-50"
        )}
        aria-label="开始实时翻译"
      >
        {supported ? (
          <Mic className={cn("h-8 w-8", listening ? "text-primary" : "text-muted-foreground")} />
        ) : (
          <MicOff className="h-8 w-8 text-muted-foreground" />
        )}
      </button>

      <h2 className="mt-4 text-lg font-semibold tracking-tight text-foreground">
        {listening ? "正在聆听…" : "实时翻译"}
      </h2>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
        点击上面的麦克风（或左上角「开始实时翻译」）→ 浏览器会请求<strong className="text-foreground/80">麦克风权限</strong>
        ，允许后即可边说边出双语字幕。
      </p>

      <div className="mt-6 grid w-full max-w-lg grid-cols-1 gap-2 text-left sm:grid-cols-3">
        <Step index={1} title="允许麦克风" body="首次点击会弹出权限请求，选“允许”。" />
        <Step index={2} title="开始说话" body="浏览器内置识别实时转成文字。" />
        <Step index={3} title="双语字幕" body="DeepSeek Flash 流式翻译，逐句出现。" />
      </div>

      <p className="mt-6 max-w-lg text-meta leading-relaxed text-muted-foreground/70">
        语音识别由浏览器内置能力完成（Chrome/Edge 会把音频发送到 Google 的语音服务）；
        发往 DeepSeek 的只有识别出的文字，你的 API Key 也只存在本机浏览器里。
      </p>
    </div>
  );
}

function Step({ index, title, body }: { index: number; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="grid h-4 w-4 place-items-center rounded-full bg-primary/15 font-mono text-[10px] text-primary">
          {index}
        </span>
        <span className="text-xs font-medium text-foreground">{title}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

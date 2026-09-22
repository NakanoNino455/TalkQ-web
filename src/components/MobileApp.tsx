import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Mic,
  MicOff,
  RadioTower,
  RefreshCw,
  ShieldAlert,
  Square,
  Subtitles,
  HelpCircle,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { MicMeter } from "./MicMeter";
import { MobileMenu } from "./MobileMenu";
import { SegmentCard } from "./SegmentCard";
import { SPEECH_LANGUAGES, TRANSLATE_DIRECTIONS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { describeEnvironmentProblem, isSpeechRecognitionSupported } from "@/lib/speech";
import { englishSideOf } from "@/lib/translate";
import { askDeepSeek } from "@/lib/ask";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";
import { showToast } from "@/stores/toastStore";

export type MobileTab = "subtitle" | "ask";

/**
 * Phone layout: one full-height pane at a time, switched by a bottom tab bar.
 * Everything important stays inside the thumb zone, and the safe-area inset is
 * respected so nothing hides under the home indicator.
 */
export function MobileApp({
  tab,
  onTabChange,
}: {
  tab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {tab === "subtitle" ? (
          <MobileTranslatePane />
        ) : (
          <MobileAskPane onClose={() => onTabChange("subtitle")} />
        )}
      </div>
      <MobileTabBar tab={tab} onTabChange={onTabChange} />
    </div>
  );
}

function MobileTabBar({
  tab,
  onTabChange,
}: {
  tab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}) {
  const status = useTranslateStore((s) => s.status);
  const segments = useTranslateStore((s) => s.segments.length);
  const answering = useChatStore((s) => s.isStreaming);

  return (
    <nav
      aria-label="主导航"
      className="pb-safe shrink-0 border-t border-border bg-card/80 backdrop-blur-xl"
    >
      <div className="grid grid-cols-2">
        <TabButton
          active={tab === "subtitle"}
          label="字幕"
          badge={segments > 0 ? String(segments) : undefined}
          live={status === "listening"}
          icon={<Subtitles className="h-5 w-5" />}
          onClick={() => onTabChange("subtitle")}
        />
        <TabButton
          active={tab === "ask"}
          label="问答"
          live={answering}
          icon={<HelpCircle className="h-5 w-5" />}
          onClick={() => onTabChange("ask")}
        />
      </div>
    </nav>
  );
}

function TabButton({
  active,
  icon,
  label,
  badge,
  live,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  badge?: string;
  live?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "relative flex flex-col items-center gap-1 py-2.5 text-[11px] transition-colors",
        active ? "text-primary" : "text-muted-foreground"
      )}
      aria-current={active ? "page" : undefined}
    >
      <span className="relative">
        {icon}
        {live && (
          <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-success live-ring-pulse" />
        )}
      </span>
      <span className="flex items-center gap-1">
        {label}
        {badge && (
          <span className="rounded-full border border-border bg-muted/50 px-1.5 text-[10px]">
            {badge}
          </span>
        )}
      </span>
      {active && <span className="absolute inset-x-6 top-0 h-0.5 rounded-full bg-primary" />}
    </button>
  );
}

/* ── Subtitle pane ───────────────────────────────────────────────────── */

function MobileTranslatePane() {
  const status = useTranslateStore((s) => s.status);
  const interim = useTranslateStore((s) => s.interim);
  const segments = useTranslateStore((s) => s.segments);
  const error = useTranslateStore((s) => s.error);
  const micLevel = useTranslateStore((s) => s.micLevel);
  const vad = useTranslateStore((s) => s.vad);  const warning = useTranslateStore((s) => s.warning);
  const clearWarning = useTranslateStore((s) => s.clearWarning);
  const unrecognisedSpeechMs = useTranslateStore((s) => s.unrecognisedSpeechMs);
  const refreshDiagnostics = useTranslateStore((s) => s.refreshDiagnostics);
  const startedAt = useTranslateStore((s) => s.startedAt);
  const toggle = useTranslateStore((s) => s.toggle);
  const clear = useTranslateStore((s) => s.clear);
  const copyAll = useTranslateStore((s) => s.copyAll);
  const setLanguage = useTranslateStore((s) => s.setLanguage);
  const retranslate = useTranslateStore((s) => s.retranslate);

  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const setDraft = useChatStore((s) => s.setDraft);

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
  }, [segments, interim, pinned]);

  useEffect(() => {
    if (!listening) return;
    const id = setInterval(refreshDiagnostics, 500);
    return () => clearInterval(id);
  }, [listening, refreshDiagnostics]);

  const handleShare = (segment: { source: string; translation: string; sourceLang: string; targetLang: string }) => {
    const english = englishSideOf(segment as never).text.trim();
    if (!english) return;
    setDraft(english);
    // The tab switch is the mobile equivalent of "put it in the ask panel".
    window.dispatchEvent(new CustomEvent("nexq:open-ask"));
    requestAnimationFrame(() => void askDeepSeek(english));
  };

  const exportTranscript = () => {
    const text = useTranslateStore.getState().exportTranscript();
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `talkq-transcript-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const statusLabel =
    status === "listening"
      ? "正在聆听"
      : status === "starting"
        ? "启动中…"
        : status === "restarting"
          ? "重连中…"
          : status === "error"
            ? "已停止"
            : "未开始";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Control header */}
      <div className="shrink-0 border-b border-border bg-background/60 px-3 pb-2.5 pt-2.5 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <Button
            variant={listening ? "destructive" : "primary"}
            size="lg"
            className="touch-target flex-1 gap-2"
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

          <button
            type="button"
            onClick={() => void toggle()}
            aria-label={listening ? "停止翻译" : "开始实时翻译"}
            className={cn(
              "touch-target grid w-11 shrink-0 place-items-center rounded-lg border transition-colors",
              listening
                ? "border-success/40 bg-success/10 text-success"
                : "border-border bg-background/60 text-muted-foreground"
            )}
          >
            {listening ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
          </button>

          <MobileMenu
            disabled={segments.length === 0}
            livePreview={settings.livePreview}
            quickMode={settings.translateQuickMode}
            onTogglePreview={() => updateSettings({ livePreview: !settings.livePreview })}
            onToggleQuickMode={() =>
              updateSettings({ translateQuickMode: !settings.translateQuickMode })
            }
            onCopyAll={async () => {
              const ok = await copyAll();
              showToast(ok ? "success" : "error", ok ? "已复制全部字幕" : "复制失败");
            }}
            onExport={exportTranscript}
            onClear={() => {
              if (window.confirm("清空本次翻译记录？")) clear();
            }}
          />
        </div>

        <div className="mt-2 flex items-center gap-2 text-[11px]">
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2 py-0.5",
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
            <span className="shrink-0 font-mono text-muted-foreground">{formatElapsed(elapsed)}</span>
          )}
          <span className="shrink-0 whitespace-nowrap text-muted-foreground">
            {segments.length} 句
          </span>
          <span className="ml-auto shrink-0 whitespace-nowrap text-muted-foreground/70">
            {settings.translateQuickMode ? "低延迟" : "标准"}
            {settings.livePreview ? " · 预览" : ""}
          </span>
        </div>

        <div className="mt-1.5 flex items-center gap-1.5">
          <select
            value={settings.translateDirection}
            onChange={(e) =>
              updateSettings({
                translateDirection: e.target.value as typeof settings.translateDirection,
              })
            }
            aria-label="翻译方向"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background/60 px-1.5 text-[11px] text-foreground focus:border-primary/50 focus:outline-none"
          >
            {TRANSLATE_DIRECTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
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
            aria-label="识别语言"
            className="h-8 min-w-0 flex-1 rounded-md border border-border bg-background/60 px-1.5 text-[11px] text-foreground focus:border-primary/50 focus:outline-none disabled:opacity-60"
          >
            {SPEECH_LANGUAGES.map((lang) => (
              <option key={lang.value} value={lang.value}>
                {lang.label}
              </option>
            ))}
          </select>
        </div>

        <MicMeter level={micLevel} active={status === "listening"} className="mt-2" bars={24} />
      </div>

      {environmentProblem && (
        <MobileBanner tone="warning" icon={<ShieldAlert className="h-4 w-4" />} title={environmentProblem.title}>
          {environmentProblem.detail}
        </MobileBanner>
      )}

      {!error && unrecognisedSpeechMs > 2500 && (
        <MobileBanner
          tone="warning"
          icon={<RadioTower className="h-4 w-4" />}
          title="听到人声，但识别没有输出"
        >
          已检测到 {Math.round(unrecognisedSpeechMs / 1000)} 秒人声却没有文字返回，信噪比太低（当前 SNR{" "}
          {vad ? `${vad.snrDb.toFixed(0)} dB` : "未知"}）。
          把手机挪近说话人，或外接麦克风；设置 → 开发者诊断里有距离校准。
        </MobileBanner>
      )}

      {!error && warning && (
        <MobileBanner
          tone="warning"
          icon={<RefreshCw className="h-4 w-4" />}
          title="识别已自动恢复"
          action={
            <Button variant="ghost" size="sm" onClick={clearWarning}>
              知道了
            </Button>
          }
        >
          {warning}
        </MobileBanner>
      )}
      {error && !environmentProblem && (
        <MobileBanner
          tone="error"
          icon={<AlertTriangle className="h-4 w-4" />}
          title={error.title}
          action={
            error.fatal ? (
              <Button
                variant="destructive"
                size="sm"
                className="touch-target gap-1.5"
                onClick={() => void useTranslateStore.getState().start()}
              >
                <RefreshCw className="h-3.5 w-3.5" />
                重试
              </Button>
            ) : undefined
          }
        >
          {error.detail}
          {error.hint && <span className="mt-0.5 block opacity-80">{error.hint}</span>}
        </MobileBanner>
      )}

      <div
        ref={scrollRef}
        onScroll={() => {
          const el = scrollRef.current;
          if (!el) return;
          setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="min-h-0 flex-1 overflow-y-auto px-3 py-3"
      >
        {segments.length === 0 && !interim ? (
          <MobileEmpty listening={listening} onStart={() => void toggle()} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {segments.map((segment, index) => (
              <SegmentCard
                key={segment.id}
                segment={segment}
                index={index}
                onRetranslate={(id) => void retranslate(id)}
                onDelete={(id) =>
                  useTranslateStore.setState((state) => ({
                    segments: state.segments.filter((s) => s.id !== id),
                  }))
                }
                onShare={handleShare}
              />
            ))}

            {interim && (
              <div className="rounded-xl border border-primary/25 bg-primary/[0.06] px-3.5 py-3">
                <div className="mb-1.5 flex items-center gap-2 text-meta text-primary/80">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-primary" />
                  正在识别…
                </div>
                <p className="subtitle-source italic text-muted-foreground">{interim}</p>
              </div>
            )}
          </div>
        )}
        <div className="h-2" />
      </div>
    </div>
  );
}

function MobileEmpty({ listening, onStart }: { listening: boolean; onStart: () => void }) {
  const supported = isSpeechRecognitionSupported();
  return (
    <div className="fade-in flex flex-col items-center px-2 pt-6 text-center">
      <button
        type="button"
        onClick={onStart}
        disabled={!supported}
        aria-label="开始实时翻译"
        className={cn(
          "grid h-28 w-28 place-items-center rounded-full border transition-all",
          listening
            ? "border-primary/50 bg-primary/15 glow-primary-strong"
            : "border-border bg-card/60 active:scale-95",
          !supported && "opacity-50"
        )}
      >
        {supported ? (
          <Mic className={cn("h-10 w-10", listening ? "text-primary" : "text-muted-foreground")} />
        ) : (
          <MicOff className="h-10 w-10 text-muted-foreground" />
        )}
      </button>

      <h2 className="mt-4 text-base font-semibold text-foreground">
        {listening ? "正在聆听…" : "点一下开始实时翻译"}
      </h2>
      <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
        会先请求<strong className="text-foreground/80">麦克风权限</strong>，允许后边说边出双语字幕。
      </p>

      <div className="mt-5 w-full max-w-xs space-y-1.5 text-left">
        <Step index={1} title="允许麦克风" body="浏览器弹出权限请求时选「允许」。" />
        <Step index={2} title="开始说话" body="识别文字实时出现，随即给出译文。" />
        <Step index={3} title="分享某句" body="点字幕上的分享按钮，自动到问答页提问。" />
      </div>
    </div>
  );
}

function Step({ index, title, body }: { index: number; title: string; body: string }) {
  return (
    <div className="rounded-xl border border-border bg-card/50 px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="grid h-4 w-4 place-items-center rounded-full bg-primary/15 font-mono text-[10px] text-primary">
          {index}
        </span>
        <span className="text-xs font-medium text-foreground">{title}</span>
      </div>
      <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{body}</p>
    </div>
  );
}

function MobileBanner({
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
        "shrink-0 border-b px-3 py-2.5",
        tone === "error"
          ? "border-destructive/30 bg-destructive/10"
          : "border-warning/30 bg-warning/10"
      )}
    >
      <div className="flex items-start gap-2">
        <span className={tone === "error" ? "mt-0.5 text-destructive" : "mt-0.5 text-warning"}>
          {icon}
        </span>
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

/* ── Ask pane ────────────────────────────────────────────────────────── */

function MobileAskPane({ onClose }: { onClose: () => void }) {
  const [Panel, setPanel] = useState<null | React.ComponentType<{ onClose: () => void; embedded?: boolean }>>(
    null
  );

  // Loaded lazily so the subtitle pane stays lean on first paint.
  useEffect(() => {
    let alive = true;
    void import("./AskPanel").then((mod) => {
      if (alive) setPanel(() => mod.AskPanel);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!Panel) return <div className="h-full" />;
  return <Panel embedded onClose={onClose} />;
}

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

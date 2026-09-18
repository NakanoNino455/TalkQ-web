import { HelpCircle, Images, Menu, Mic, Settings, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  CONTEXT_WINDOW_LABEL,
  MODEL_LABEL,
  MODEL_VERSION_LABEL,
  TRANSLATE_DIRECTIONS,
} from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";

/** Top bar: live translation status, model identity, ask-panel toggle, settings. */
export function TopBar({
  onOpenSettings,
  onToggleSidebar,
  askOpen,
  onToggleAsk,
}: {
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
  askOpen: boolean;
  onToggleAsk: () => void;
}) {
  const translateStatus = useTranslateStore((s) => s.status);
  const segmentCount = useTranslateStore((s) => s.segments.length);
  const direction = useSettingsStore((s) => s.settings.translateDirection);

  const directionLabel =
    TRANSLATE_DIRECTIONS.find((d) => d.value === direction)?.label ?? "自动互译";

  return (
    <header className="dash-header flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/60 px-3 backdrop-blur-xl sm:px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        aria-label="Toggle sidebar"
      >
        <Menu className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[13px] font-medium text-foreground">实时翻译</h1>
        <p className="truncate text-meta text-muted-foreground">
          {directionLabel} · {segmentCount} 句 · {MODEL_VERSION_LABEL}
        </p>
      </div>

      {/* Model identity — fixed to DeepSeek Flash, no provider switcher. */}
      <div className="hidden items-center gap-2 md:flex">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
          <Sparkles className="h-3 w-3" />
          {MODEL_LABEL}
        </span>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
            translateStatus === "listening"
              ? "border-success/40 bg-success/10 text-success"
              : "border-border bg-muted/40 text-muted-foreground"
          )}
        >
          <Mic className="h-3 w-3" />
          {translateStatus === "listening" ? "麦克风已开启" : "麦克风未开启"}
        </span>
        <span className="hidden items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground lg:inline-flex">
          <Images className="h-3 w-3" />
          {CONTEXT_WINDOW_LABEL} · Vision
        </span>
      </div>

      <Button
        variant={askOpen ? "secondary" : "ghost"}
        size="md"
        className="gap-2"
        onClick={onToggleAsk}
        title={askOpen ? "收起问答栏（Ctrl+Shift+K）" : "展开问答栏，粘贴问题即可提问"}
      >
        <HelpCircle className={cn("h-4 w-4", askOpen && "text-primary")} />
        <span className="hidden sm:inline">问答</span>
      </Button>

      <Button variant="ghost" size="md" className="gap-2" onClick={onOpenSettings}>
        <Settings className="h-4 w-4" />
        <span className="hidden sm:inline">Settings</span>
      </Button>
    </header>
  );
}

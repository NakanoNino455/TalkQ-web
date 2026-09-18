import { Images, Menu, Settings, Sparkles, SquarePen } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  CONTEXT_WINDOW_LABEL,
  CONTEXT_WINDOW_TOKENS,
  MODEL_LABEL,
  MODEL_VERSION_LABEL,
} from "@/lib/constants";
import { estimateConversationTokens } from "@/lib/tokens";
import { cn, formatCompact } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";

/** Top bar: current chat, model identity (DeepSeek Flash · 1M Context), settings. */
export function TopBar({
  onOpenSettings,
  onToggleSidebar,
}: {
  onOpenSettings: () => void;
  onToggleSidebar: () => void;
}) {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const active = conversations.find((c) => c.id === activeId) ?? null;

  const usedTokens = active ? estimateConversationTokens(active.messages) : 0;
  const usedFraction = Math.min(1, usedTokens / CONTEXT_WINDOW_TOKENS);

  return (
    <header className="dash-header flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/60 px-3 backdrop-blur-xl sm:px-4">
      <button
        type="button"
        onClick={onToggleSidebar}
        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground lg:hidden"
        aria-label="Toggle sidebar"
      >
        <Menu className="h-4 w-4" />
      </button>

      <div className="min-w-0 flex-1">
        <h1 className="truncate text-[13px] font-medium text-foreground">
          {active?.title ?? "New chat"}
        </h1>
        <p className="truncate text-meta text-muted-foreground">
          {active ? `${active.messages.length} messages` : "No messages yet"} ·{" "}
          {MODEL_VERSION_LABEL}
        </p>
      </div>

      {/* Model identity — fixed to DeepSeek Flash, no provider switcher. */}
      <div className="hidden items-center gap-2 md:flex">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2.5 py-1 text-[11px] font-medium text-primary">
          <Sparkles className="h-3 w-3" />
          {MODEL_LABEL}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
          {CONTEXT_WINDOW_LABEL}
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/40 px-2.5 py-1 text-[11px] text-muted-foreground">
          <Images className="h-3 w-3" />
          Vision
        </span>
      </div>

      {/* Context meter against the real 1M window */}
      <div className="hidden w-32 shrink-0 lg:block" title={`~${formatCompact(usedTokens)} of 1M context tokens used`}>
        <div className="flex items-center justify-between text-meta text-muted-foreground">
          <span>context</span>
          <span className="font-mono">{formatCompact(usedTokens)}/1M</span>
        </div>
        <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted/60">
          <div
            className={cn(
              "h-full rounded-full transition-all duration-500",
              usedFraction > 0.9
                ? "bg-destructive"
                : usedFraction > 0.7
                  ? "bg-warning"
                  : "bg-primary/70"
            )}
            style={{ width: `${Math.max(usedFraction * 100, usedTokens > 0 ? 2 : 0)}%` }}
          />
        </div>
      </div>

      <Button variant="ghost" size="md" className="gap-2" onClick={onOpenSettings}>
        <Settings className="h-4 w-4" />
        <span className="hidden sm:inline">Settings</span>
      </Button>
      <span className="hidden text-muted-foreground xl:inline" aria-hidden>
        <SquarePen className="h-3.5 w-3.5" />
      </span>
    </header>
  );
}

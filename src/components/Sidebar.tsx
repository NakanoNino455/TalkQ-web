import { useMemo, useState } from "react";
import {
  HelpCircle,
  Mic,
  Plus,
  Search,
  Settings,
  Trash2,
  X,
  KeyRound,
  CheckCircle2,
} from "lucide-react";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/Button";
import { cn, formatRelative } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";

/** Left rail: brand, live-session stats, Q&A history, key status. */
export function Sidebar({
  onOpenSettings,
  onClose,
  className,
}: {
  onOpenSettings: () => void;
  onClose?: () => void;
  className?: string;
}) {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const newChat = useChatStore((s) => s.newChat);
  const selectChat = useChatStore((s) => s.selectChat);
  const deleteChat = useChatStore((s) => s.deleteChat);
  const clearAllChats = useChatStore((s) => s.clearAllChats);
  const apiKey = useSettingsStore((s) => s.apiKey);
  const translateStatus = useTranslateStore((s) => s.status);
  const translateSegments = useTranslateStore((s) => s.segments.length);

  const [filter, setFilter] = useState("");

  const sorted = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations]
  );

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter((c) => {
      if (c.title.toLowerCase().includes(q)) return true;
      return c.messages.some((m) => m.content.toLowerCase().includes(q));
    });
  }, [sorted, filter]);

  return (
    <aside
      className={cn(
        "dash-sidebar flex h-full w-[16.5rem] shrink-0 flex-col border-r border-border bg-card/40 backdrop-blur-xl",
        className
      )}
    >
      <div className="flex items-center justify-between px-3.5 pb-3 pt-4">
        <Logo subtitle="Web" />
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground lg:hidden"
            aria-label="Close sidebar"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="mt-3 px-3.5">
        <div className="rounded-lg border border-border bg-card/50 p-3">
          <div className="flex items-center gap-1.5">
            <Mic
              className={cn(
                "h-3 w-3",
                translateStatus === "listening" ? "text-success" : "text-muted-foreground"
              )}
            />
            <p className="text-meta uppercase tracking-[0.16em] text-muted-foreground">本次会话</p>
            {translateStatus === "listening" && (
              <span className="ml-auto h-1.5 w-1.5 rounded-full bg-success live-ring-pulse" />
            )}
          </div>
          <p className="mt-1.5 text-xs text-foreground">{translateSegments} 句字幕</p>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            点主区域麦克风开始；允许权限后浏览器内置识别实时转文字，再由 DeepSeek Flash 逐句翻译。
            右侧「问答」栏可直接粘贴问题，并带上刚才的字幕一起问。
          </p>
        </div>
      </div>

      <div className="mt-3 px-3.5">
        <Button
          variant="primary"
          size="md"
          className="w-full justify-start gap-2"
          onClick={newChat}
        >
          <Plus className="h-4 w-4" />
          新问答
        </Button>
      </div>

      <div className="mt-3 px-3.5">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索问答记录"
            className="h-8 w-full rounded-md border border-border bg-background/60 pl-8 pr-2 text-[11px] text-foreground placeholder:text-muted-foreground/70 focus:border-primary/50 focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-4 flex items-center justify-between px-4">
        <span className="text-meta uppercase tracking-[0.16em] text-muted-foreground">
          问答记录 {sorted.length > 0 && `· ${sorted.length}`}
        </span>
        {sorted.length > 0 && (
          <button
            type="button"
            onClick={() => {
              if (window.confirm("清空全部问答记录？（字幕不受影响）")) clearAllChats();
            }}
            className="rounded p-1 text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
            title="清空问答记录"
            aria-label="清空问答记录"
          >
            <Trash2 className="h-3 w-3" />
          </button>
        )}
      </div>

      <nav className="mt-2 flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
        {visible.length === 0 && (
          <p className="px-2.5 py-3 text-[11px] leading-relaxed text-muted-foreground">
            {sorted.length === 0
              ? "还没有问答。右侧「问答」栏粘贴问题即可，记录只存在本机浏览器。"
              : "没有匹配的问答记录。"}
          </p>
        )}

        {visible.map((conversation) => {
          const isActive = conversation.id === activeId;
          const last = conversation.messages[conversation.messages.length - 1];
          const preview = last?.content?.replace(/\s+/g, " ").trim() || "空会话";
          return (
            <div
              key={conversation.id}
              className={cn(
                "group relative flex items-center rounded-lg transition-colors",
                isActive ? "bg-primary/10" : "hover:bg-accent/60"
              )}
            >
              {isActive && (
                <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary" />
              )}
              <button
                type="button"
                onClick={() => selectChat(conversation.id)}
                className="min-w-0 flex-1 px-2.5 py-2 text-left"
              >
                <div className="flex items-center gap-1.5">
                  <HelpCircle
                    className={cn(
                      "h-3 w-3 shrink-0",
                      isActive ? "text-primary" : "text-muted-foreground"
                    )}
                  />
                  <span
                    className={cn(
                      "truncate text-xs font-medium",
                      isActive ? "text-foreground" : "text-foreground/85"
                    )}
                  >
                    {conversation.title}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5 pl-[1.15rem]">
                  <span className="truncate text-[10px] text-muted-foreground">{preview}</span>
                </div>
                <div className="mt-0.5 pl-[1.15rem] text-meta text-muted-foreground/70">
                  {formatRelative(conversation.updatedAt)} · {conversation.messages.length} msg
                </div>
              </button>
              <button
                type="button"
                onClick={() => deleteChat(conversation.id)}
                className="mr-1.5 rounded p-1.5 text-muted-foreground opacity-0 transition-all hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100"
                title="删除这条问答"
                aria-label={`删除 ${conversation.title}`}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </nav>

      <div className="border-t border-border px-3.5 py-3">
        <div className="flex items-center gap-2 rounded-lg border border-border bg-background/50 px-2.5 py-2">
          <span
            className={cn(
              "h-1.5 w-1.5 shrink-0 rounded-full",
              apiKey ? "bg-success live-ring-pulse" : "bg-warning"
            )}
          />
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {apiKey ? "DeepSeek key stored locally" : "No API key yet"}
          </span>
        </div>
        <Button
          variant="ghost"
          size="md"
          className="mt-2 w-full justify-start gap-2"
          onClick={onOpenSettings}
        >
          <Settings className="h-4 w-4" />
          Settings
        </Button>
        <div className="mt-1 flex items-center gap-1.5 px-1 text-meta text-muted-foreground/70">
          {apiKey ? (
            <CheckCircle2 className="h-3 w-3 text-success/70" />
          ) : (
            <KeyRound className="h-3 w-3 text-warning" />
          )}
          <span>
            {apiKey ? "Connected in this browser" : "Add a key in Settings"}
          </span>
        </div>
      </div>
    </aside>
  );
}

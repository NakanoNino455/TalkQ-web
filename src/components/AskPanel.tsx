import { useMemo } from "react";
import { ClipboardList, HelpCircle, PanelRightClose, Trash2 } from "lucide-react";
import { ChatView } from "./ChatView";
import { Composer } from "./Composer";
import { askDeepSeek } from "@/lib/ask";
import { buildTranscriptContext } from "@/lib/translate";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { useTranslateStore } from "@/stores/translateStore";

/**
 * Q&A panel embedded in the live-translation surface.
 *
 * Same DeepSeek chat underneath (streaming, Markdown, images, regenerate), but
 * it lives next to the subtitles so you can paste a question and — with the
 * context toggle on — have the model answer against what was just said.
 */
export function AskPanel({
  onClose,
  embedded,
  className,
}: {
  onClose: () => void;
  /** Mobile tab mode: the bottom tab bar owns the navigation chrome. */
  embedded?: boolean;
  className?: string;
}) {
  const settings = useSettingsStore((s) => s.settings);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const segments = useTranslateStore((s) => s.segments);
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const clearAllChats = useChatStore((s) => s.clearAllChats);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const doneSegments = useMemo(
    () => segments.filter((s) => s.source.trim()),
    [segments]
  );
  const contextLength = useMemo(
    () => (settings.askUseTranscriptContext ? buildTranscriptContext(doneSegments).length : 0),
    [doneSegments, settings.askUseTranscriptContext]
  );

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const messageCount = active?.messages.length ?? 0;

  /**
   * Paste-and-ask with the newest subtitles attached (shared with the subtitle
   * share button, so both paths behave identically).
   */
  const handleSend = () => {
    void askDeepSeek();
  };

  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col bg-card/40 backdrop-blur-xl",
        embedded ? "border-0" : "border-l border-border",
        className
      )}
      aria-label="问答"
    >
      <header
        className={cn(
          "flex items-center gap-2 border-b border-border px-3",
          embedded ? "py-2.5" : "py-2.5"
        )}
      >
        <HelpCircle className="h-3.5 w-3.5 text-primary" />
        <h2 className="text-[13px] font-medium text-foreground">问答</h2>
        {messageCount > 0 && (
          <span className="rounded-full border border-border bg-muted/40 px-1.5 py-px text-meta text-muted-foreground">
            {messageCount}
          </span>
        )}
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            title="清空问答"
            aria-label="清空问答"
            disabled={messageCount === 0 || isStreaming}
            onClick={() => {
              if (window.confirm("清空问答记录？字幕不受影响。")) clearAllChats();
            }}
            className={cn(
              "rounded p-1.5 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-40",
              embedded && "touch-target grid place-items-center p-0"
            )}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
          {!embedded && (
            <button
              type="button"
              title="收起问答栏"
              aria-label="收起问答栏"
              onClick={onClose}
              className="rounded p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <PanelRightClose className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </header>

      {/* Context switch — the whole point of embedding the chat here */}
      <div className="border-b border-border px-3 py-2">
        <button
          type="button"
          onClick={() => updateSettings({ askUseTranscriptContext: !settings.askUseTranscriptContext })}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border px-2.5 py-2 text-left transition-colors",
            settings.askUseTranscriptContext
              ? "border-primary/30 bg-primary/10"
              : "border-border bg-background/50 hover:border-border/80"
          )}
        >
          <ClipboardList
            className={cn(
              "h-3.5 w-3.5 shrink-0",
              settings.askUseTranscriptContext ? "text-primary" : "text-muted-foreground"
            )}
          />
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block text-[11px] font-medium",
                settings.askUseTranscriptContext ? "text-primary" : "text-foreground/85"
              )}
            >
              附带最近字幕作为上下文
            </span>
            <span className="mt-0.5 block text-meta text-muted-foreground">
              {settings.askUseTranscriptContext
                ? doneSegments.length > 0
                  ? `已带上最近 ${Math.min(doneSegments.length, 12)} 句（约 ${contextLength} 字）`
                  : "还没有字幕，问答就是普通对话"
                : "关闭：只按你输入的内容回答"}
            </span>
          </span>
        </button>
      </div>

      <ChatView variant="panel" onSendOverride={handleSend} />
      <Composer variant="panel" onSendOverride={handleSend} />
    </aside>
  );
}

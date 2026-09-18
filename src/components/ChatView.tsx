import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Code2,
  FileText,
  Images,
  Languages,
  Lightbulb,
  ScanSearch,
  ShieldCheck,
  Sparkles,
  Zap,
} from "lucide-react";
import { MessageCard } from "./MessageCard";
import { Button } from "@/components/ui/Button";
import { CONTEXT_WINDOW_LABEL, DEFAULT_IMAGE_PROMPT, MODEL_LABEL } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { showToast } from "@/stores/toastStore";

/** Conversation surface: message list, streaming auto-scroll, empty state. */
export function ChatView() {
  const conversations = useChatStore((s) => s.conversations);
  const activeId = useChatStore((s) => s.activeId);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const streamingMessageId = useChatStore((s) => s.streamingMessageId);
  const regenerate = useChatStore((s) => s.regenerate);
  const deleteMessage = useChatStore((s) => s.deleteMessage);
  const setDraft = useChatStore((s) => s.setDraft);

  const active = conversations.find((c) => c.id === activeId) ?? null;
  const messages = active?.messages ?? [];

  const scrollRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);

  // Follow the stream while the user is parked at the bottom.
  useEffect(() => {
    if (!pinned || !scrollRef.current) return;
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, pinned, isStreaming]);

  useEffect(() => {
    setPinned(true);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [activeId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setPinned(distance < 80);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setPinned(true);
  };

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-3 py-5 sm:px-6"
      >
        <div className="mx-auto flex w-full max-w-chat flex-col gap-5">
          {messages.length === 0 ? (
            <EmptyState onPick={setDraft} />
          ) : (
            messages.map((message) => (
              <MessageCard
                key={message.id}
                message={message}
                streaming={isStreaming && streamingMessageId === message.id}
                onRegenerate={regenerate}
                onDelete={deleteMessage}
              />
            ))
          )}
          <div className="h-2" />
        </div>
      </div>

      {!pinned && messages.length > 0 && (
        <Button
          variant="secondary"
          size="sm"
          onClick={jumpToLatest}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 gap-1.5 rounded-full shadow-lg"
        >
          <ArrowDown className="h-3 w-3" />
          Jump to latest
        </Button>
      )}
    </div>
  );
}

const SUGGESTIONS = [
  {
    icon: FileText,
    title: "总结内容",
    prompt: "请把下面这段内容总结成 5 条要点，并给出结论：\n\n",
  },
  {
    icon: Code2,
    title: "解释代码",
    prompt: "解释这段代码的作用，指出潜在问题并给出改进建议：\n\n```\n\n```",
  },
  {
    icon: Languages,
    title: "中英互译",
    prompt: "把下面的内容翻译成自然流畅的中文，保留专业术语：\n\n",
  },
  {
    icon: ScanSearch,
    title: "分析图片",
    prompt: DEFAULT_IMAGE_PROMPT,
  },
];

function EmptyState({ onPick }: { onPick: (text: string) => void }) {
  return (
    <div className="fade-in flex flex-col items-center pt-6 text-center sm:pt-12">
      <div className="dash-modal grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-primary to-[hsl(220_80%_45%)] glow-primary-strong">
        <Sparkles className="h-6 w-6 text-primary-foreground" />
      </div>

      <h2 className="mt-4 text-xl font-semibold tracking-tight text-foreground">
        NexQ Web
      </h2>
      <p className="mt-1.5 max-w-md text-xs leading-relaxed text-muted-foreground">
        A 100% browser-side DeepSeek client. Your key lives in this browser only — requests go
        straight to <span className="font-mono">api.deepseek.com</span>.
      </p>

      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <Chip icon={<Sparkles className="h-3 w-3" />} label={MODEL_LABEL} accent />
        <Chip icon={<Zap className="h-3 w-3" />} label={CONTEXT_WINDOW_LABEL} />
        <Chip icon={<Images className="h-3 w-3" />} label="Vision · JPEG/PNG/GIF/WebP" />
        <Chip icon={<ShieldCheck className="h-3 w-3" />} label="No backend, no tracking" />
      </div>

      <div className="mt-7 grid w-full max-w-lg grid-cols-1 gap-2 sm:grid-cols-2">
        {SUGGESTIONS.map((item) => (
          <button
            key={item.title}
            type="button"
            onClick={() => {
              if (item.title === "分析图片") {
                onPick(item.prompt);
                showToast(
                  "info",
                  "Paste a screenshot",
                  "Press Win + Shift + S, then hit Ctrl + V right here."
                );
                return;
              }
              onPick(item.prompt);
            }}
            className="group flex items-start gap-2.5 rounded-xl border border-border bg-card/50 px-3.5 py-3 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:bg-card/80"
          >
            <item.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary/70 transition-colors group-hover:text-primary" />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">{item.title}</span>
              <span className="mt-0.5 block truncate text-[11px] text-muted-foreground">
                {item.prompt.replace(/\s+/g, " ").slice(0, 42) || DEFAULT_IMAGE_PROMPT}
              </span>
            </span>
          </button>
        ))}
      </div>

      <p className="mt-6 inline-flex items-center gap-1.5 text-meta text-muted-foreground/80">
        <Lightbulb className="h-3 w-3" />
        Tip: drag & drop an image, or screenshot with Win+Shift+S and paste with Ctrl+V
      </p>
    </div>
  );
}

function Chip({
  icon,
  label,
  accent,
}: {
  icon: React.ReactNode;
  label: string;
  accent?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px]",
        accent
          ? "border-primary/30 bg-primary/10 text-primary"
          : "border-border bg-muted/40 text-muted-foreground"
      )}
    >
      {icon}
      {label}
    </span>
  );
}

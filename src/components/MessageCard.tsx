import { memo, useState } from "react";
import {
  AlertTriangle,
  Check,
  Clock3,
  Copy,
  FileText,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import type { ChatMessage } from "@/types";
import { MODEL_LABEL } from "@/lib/constants";
import { cn, copyText, formatBytes, formatClock, formatDuration } from "@/lib/utils";
import { useLightboxStore } from "@/stores/lightboxStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";

interface MessageCardProps {
  message: ChatMessage;
  streaming: boolean;
  onRegenerate: (id: string) => void;
  onDelete: (id: string) => void;
}

export const MessageCard = memo(function MessageCard({
  message,
  streaming,
  onRegenerate,
  onDelete,
}: MessageCardProps) {
  return message.role === "user" ? (
    <UserMessage message={message} onDelete={onDelete} />
  ) : (
    <AssistantMessage
      message={message}
      streaming={streaming}
      onRegenerate={onRegenerate}
      onDelete={onDelete}
    />
  );
});

/* ── Shared bits ─────────────────────────────────────────────────────── */

function ActionButton({
  label,
  icon,
  onClick,
  tone = "default",
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  tone?: "default" | "danger";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-1.5 py-1 text-[11px] transition-colors",
        tone === "danger"
          ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <ActionButton
      label={copied ? "Copied" : "Copy"}
      icon={copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1600);
        }
      }}
    />
  );
}

function ImageRow({ images }: { images: NonNullable<ChatMessage["images"]> }) {
  const openLightbox = useLightboxStore((s) => s.open);
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((image) => (
        <button
          key={image.id}
          type="button"
          onClick={() => openLightbox(image.dataUrl, `${image.name} · ${formatBytes(image.size)}`)}
          className="group overflow-hidden rounded-xl border border-border bg-muted/25"
          title={`${image.name} · ${formatBytes(image.size)}`}
        >
          {image.dataUrl ? (
            <img
              src={image.dataUrl}
              alt={image.name}
              className="max-h-52 max-w-[15rem] object-cover transition-transform duration-200 group-hover:scale-[1.02]"
            />
          ) : (
            <span className="grid h-20 w-32 place-items-center text-[10px] text-muted-foreground">
              image removed from local storage
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

/* ── User turn ───────────────────────────────────────────────────────── */

function UserMessage({
  message,
  onDelete,
}: {
  message: ChatMessage;
  onDelete: (id: string) => void;
}) {
  return (
    <div className="message-enter flex justify-end">
      <div className="flex max-w-[min(85%,42rem)] flex-col items-end gap-2">
        {message.images && message.images.length > 0 && <ImageRow images={message.images} />}

        {message.documentNames && message.documentNames.length > 0 && (
          <div className="flex flex-wrap justify-end gap-1.5">
            {message.documentNames.map((name) => (
              <span
                key={name}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/60 px-2 py-1 text-[11px] text-muted-foreground"
              >
                <FileText className="h-3 w-3 text-primary/70" />
                {name}
              </span>
            ))}
          </div>
        )}

        {message.content && (
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md border border-primary/25 bg-primary/10 px-3.5 py-2.5 text-[13.5px] leading-relaxed text-foreground">
            {message.content}
          </div>
        )}

        <div className="flex items-center gap-1 opacity-70 transition-opacity hover:opacity-100">
          <span className="px-1 text-meta text-muted-foreground/70">
            {formatClock(message.createdAt)}
          </span>
          <CopyButton text={message.content} />
          <ActionButton
            label="Delete"
            tone="danger"
            icon={<Trash2 className="h-3 w-3" />}
            onClick={() => onDelete(message.id)}
          />
        </div>
      </div>
    </div>
  );
}

/* ── Assistant turn ──────────────────────────────────────────────────── */

function AssistantMessage({
  message,
  streaming,
  onRegenerate,
  onDelete,
}: MessageCardProps) {
  const showReasoning = useSettingsStore((s) => s.settings.showReasoning);
  const hasContent = message.content.trim().length > 0;
  const hasReasoning = Boolean(message.reasoning?.trim()) && showReasoning;
  const isError = message.status === "error" && message.error;
  const isAborted = message.status === "aborted";

  return (
    <div className="message-enter group/message flex gap-2.5">
      <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg border border-primary/25 bg-gradient-to-br from-primary/25 to-primary/5">
        <Sparkles className={cn("h-3.5 w-3.5 text-primary", streaming && "animate-pulse")} />
      </div>

      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-2">
          <span className="text-[11px] font-medium text-foreground/90">{MODEL_LABEL}</span>
          <span className="text-meta text-muted-foreground/70">
            {formatClock(message.createdAt)}
          </span>

          {streaming && (
            <span className="inline-flex items-center gap-1 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-meta text-primary">
              <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
              streaming
            </span>
          )}

          {isAborted && !streaming && (
            <span className="inline-flex items-center gap-1 rounded-full border border-warning/30 bg-warning/10 px-1.5 py-0.5 text-meta text-warning">
              <Square className="h-2.5 w-2.5" />
              stopped
            </span>
          )}

          {!streaming && message.durationMs != null && (
            <span className="inline-flex items-center gap-1 text-meta text-muted-foreground/60">
              <Clock3 className="h-2.5 w-2.5" />
              {formatDuration(message.durationMs)}
              {message.usage?.completion_tokens
                ? ` · ${message.usage.completion_tokens} tok`
                : ""}
            </span>
          )}
        </div>

        <div
          className={cn(
            "rounded-2xl rounded-tl-md border px-3.5 py-3 backdrop-blur-sm",
            isError
              ? "border-destructive/40 bg-destructive/10"
              : "border-border bg-card/60"
          )}
        >
          {hasReasoning && (
            <ThinkingBlock
              reasoning={message.reasoning ?? ""}
              streaming={streaming && !hasContent}
            />
          )}

          {isError && message.error && (
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-medium text-destructive">{message.error.title}</p>
                {message.error.detail && (
                  <p className="mt-1 break-words font-mono text-[11px] leading-snug text-destructive/85">
                    {message.error.detail}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => onRegenerate(message.id)}
                  className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/15 px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/25"
                >
                  <RefreshCw className="h-3 w-3" />
                  Try again
                </button>
              </div>
            </div>
          )}

          {!hasContent && !hasReasoning && streaming && (
            <div className="flex items-center gap-2 py-0.5">
              <span className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <span
                    key={i}
                    className="typing-dot h-1.5 w-1.5 rounded-full bg-primary/80"
                    style={{ animationDelay: `${i * 0.16}s` }}
                  />
                ))}
              </span>
              <span className="shimmer-text text-[11px] font-medium">Thinking…</span>
            </div>
          )}

          {hasContent && (
            <div>
              <Markdown content={message.content} />
              {streaming && <span className="stream-caret" aria-hidden />}
            </div>
          )}
        </div>

        {!streaming && (
          <div className="mt-1 flex items-center gap-1 opacity-60 transition-opacity focus-within:opacity-100 group-hover/message:opacity-100 hover:opacity-100">
            <CopyButton text={message.content} />
            <ActionButton
              label="Regenerate"
              icon={<RefreshCw className="h-3 w-3" />}
              onClick={() => onRegenerate(message.id)}
            />
            <ActionButton
              label="Delete"
              tone="danger"
              icon={<Trash2 className="h-3 w-3" />}
              onClick={() => onDelete(message.id)}
            />
          </div>
        )}
      </div>
    </div>
  );
}

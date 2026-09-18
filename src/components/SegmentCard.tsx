import { useState } from "react";
import { AlertTriangle, Check, Copy, RefreshCw, Trash2 } from "lucide-react";
import type { TranslateSegment } from "@/types";
import { LANG_LABELS } from "@/lib/constants";
import { cn, copyText, formatDuration } from "@/lib/utils";

/** One subtitle row: recognized original on top, streaming translation below. */
export function SegmentCard({
  segment,
  index,
  onRetranslate,
  onDelete,
}: {
  segment: TranslateSegment;
  index: number;
  onRetranslate: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  const [copied, setCopied] = useState<"translation" | "source" | null>(null);
  const streaming = segment.status === "streaming";

  const copy = async (kind: "translation" | "source") => {
    const text = kind === "translation" ? segment.translation : segment.source;
    if (!text.trim()) return;
    if (await copyText(text)) {
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    }
  };

  const time = new Date(segment.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  return (
    <div
      className={cn(
        "message-enter group/seg rounded-xl border px-3.5 py-3 backdrop-blur-sm transition-colors",
        segment.status === "error"
          ? "border-destructive/40 bg-destructive/10"
          : "border-border bg-card/55 hover:border-border/80"
      )}
    >
      <div className="mb-1.5 flex items-center gap-2 text-meta text-muted-foreground">
        <span className="grid h-4 min-w-4 place-items-center rounded bg-muted/60 px-1 font-mono text-[10px]">
          {index + 1}
        </span>
        <span>{time}</span>
        <span className="rounded border border-border bg-muted/40 px-1.5 py-px font-mono text-[9px] uppercase tracking-wide">
          {LANG_LABELS[segment.sourceLang] ?? segment.sourceLang} → {LANG_LABELS[segment.targetLang] ?? segment.targetLang}
        </span>
        {streaming && (
          <span className="inline-flex items-center gap-1 text-primary">
            <span className="h-1 w-1 animate-pulse rounded-full bg-primary" />
            翻译中
          </span>
        )}
        {segment.durationMs != null && !streaming && (
          <span className="text-muted-foreground/60">{formatDuration(segment.durationMs)}</span>
        )}

        <span className="ml-auto flex items-center gap-0.5 opacity-60 transition-opacity group-hover/seg:opacity-100">
          <IconAction
            label={copied === "translation" ? "已复制" : "复制译文"}
            onClick={() => copy("translation")}
            icon={copied === "translation" ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          />
          <IconAction
            label={copied === "source" ? "已复制" : "复制原文"}
            onClick={() => copy("source")}
            icon={copied === "source" ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
          />
          <IconAction label="重新翻译" onClick={() => onRetranslate(segment.id)} icon={<RefreshCw className="h-3 w-3" />} />
          <IconAction label="删除" onClick={() => onDelete(segment.id)} icon={<Trash2 className="h-3 w-3" />} danger />
        </span>
      </div>

      <p className="text-[12.5px] leading-relaxed text-muted-foreground">{segment.source}</p>

      {segment.status === "error" && segment.error ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[12px] text-destructive">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          {segment.error}
        </p>
      ) : (
        <p className="mt-1.5 whitespace-pre-wrap text-[15px] leading-relaxed text-foreground">
          {segment.translation}
          {streaming && <span className="stream-caret" aria-hidden />}
        </p>
      )}
    </div>
  );
}

function IconAction({
  label,
  icon,
  onClick,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      className={cn(
        "rounded p-1 transition-colors",
        danger
          ? "text-muted-foreground hover:bg-destructive/15 hover:text-destructive"
          : "text-muted-foreground hover:bg-accent hover:text-foreground"
      )}
    >
      {icon}
    </button>
  );
}

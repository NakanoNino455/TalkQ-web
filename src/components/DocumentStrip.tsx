import { FileText, Loader2, X } from "lucide-react";
import type { DocumentAttachment } from "@/types";
import { cn, formatBytes } from "@/lib/utils";

const KIND_STYLE: Record<string, string> = {
  pdf: "border-destructive/40 bg-destructive/10 text-destructive",
  docx: "border-info/40 bg-info/10 text-info",
  txt: "border-border bg-muted/50 text-muted-foreground",
};

/**
 * Documents attached to the next question. Their extracted text is sent along
 * with every question until they are removed — the tray is deliberately sticky
 * so follow-up questions about the same file keep working.
 */
export function DocumentStrip({
  documents,
  onRemove,
  busy,
  className,
}: {
  documents: DocumentAttachment[];
  onRemove: (id: string) => void;
  busy?: boolean;
  className?: string;
}) {
  if (documents.length === 0 && !busy) return null;

  const totalChars = documents.reduce((sum, doc) => sum + doc.chars, 0);

  return (
    <div className={cn("flex flex-wrap items-center gap-1.5 px-1 pb-2", className)}>
      {documents.map((doc) => (
        <span
          key={doc.id}
          className="slide-up group/doc inline-flex max-w-full items-center gap-1.5 rounded-lg border border-border bg-card/70 py-1 pl-2 pr-1"
          title={`${doc.name} · ${formatBytes(doc.size)} · ${doc.chars} 字${
            doc.note ? ` · ${doc.note}` : ""
          }`}
        >
          <FileText className="h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span
            className={cn(
              "shrink-0 rounded border px-1 font-mono text-[9px] uppercase",
              KIND_STYLE[doc.kind] ?? KIND_STYLE.txt
            )}
          >
            {doc.kind}
          </span>
          <span className="min-w-0 max-w-[9rem] truncate text-[11px] text-foreground/90">
            {doc.name}
          </span>
          <span className="shrink-0 text-meta text-muted-foreground">
            {doc.chars >= 1000 ? `${Math.round(doc.chars / 1000)}k字` : `${doc.chars}字`}
          </span>
          <button
            type="button"
            onClick={() => onRemove(doc.id)}
            aria-label={`移除 ${doc.name}`}
            className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
          >
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}

      {busy && (
        <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-card/70 px-2 py-1 text-[11px] text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          正在解析文档…
        </span>
      )}

      {documents.length > 0 && (
        <span className="text-meta text-muted-foreground/70">
          每次提问都会带上（共 {totalChars >= 1000 ? `${Math.round(totalChars / 1000)}k` : totalChars} 字）
        </span>
      )}
    </div>
  );
}

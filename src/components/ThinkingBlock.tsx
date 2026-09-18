import { useEffect, useState } from "react";
import { Brain, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * DeepSeek thinking-mode chain of thought.
 * Open while the model is reasoning ("Thinking…"), auto-collapsed once the
 * answer starts so it never pushes the actual reply off screen.
 */
export function ThinkingBlock({
  reasoning,
  streaming,
  seconds,
}: {
  reasoning: string;
  streaming: boolean;
  seconds?: number;
}) {
  const [open, setOpen] = useState(true);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!streaming && !touched) setOpen(false);
  }, [streaming, touched]);

  if (!reasoning.trim()) return null;

  return (
    <div className="mb-2.5 overflow-hidden rounded-lg border border-border/70 bg-muted/15">
      <button
        type="button"
        onClick={() => {
          setTouched(true);
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-accent/40"
        aria-expanded={open}
      >
        <Brain className="h-3.5 w-3.5 shrink-0 text-primary/70" />
        <span className="text-meta uppercase tracking-[0.16em]">
          {streaming ? (
            <span className="shimmer-text">Thinking…</span>
          ) : (
            <span className="text-muted-foreground">
              Thought{seconds ? ` for ${seconds}s` : ""}
            </span>
          )}
        </span>
        <ChevronRight
          className={cn(
            "ml-auto h-3.5 w-3.5 text-muted-foreground transition-transform duration-200",
            open && "rotate-90"
          )}
        />
      </button>

      {open && (
        <div className="max-h-64 overflow-y-auto border-t border-border/60 px-3 py-2.5">
          <pre className="whitespace-pre-wrap break-words font-sans text-[12px] leading-relaxed text-muted-foreground">
            {reasoning}
          </pre>
        </div>
      )}
    </div>
  );
}

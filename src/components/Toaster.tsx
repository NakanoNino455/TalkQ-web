import { useEffect, useRef, useState } from "react";
import { CheckCircle2, Info, X, XCircle } from "lucide-react";
import { useToastStore, type ToastItem } from "@/stores/toastStore";
import { cn } from "@/lib/utils";

const ICONS = { success: CheckCircle2, error: XCircle, info: Info } as const;

const ACCENT = {
  success: "border-l-[hsl(var(--success))]",
  error: "border-l-[hsl(var(--destructive))]",
  info: "border-l-[hsl(var(--info))]",
} as const;

const ICON_STYLE = {
  success: "bg-success/15 text-success toast-icon-pop",
  error: "bg-destructive/15 text-destructive toast-icon-pop",
  info: "bg-info/15 text-info toast-icon-pop",
} as const;

const PROGRESS = {
  success: "bg-success/50",
  error: "bg-destructive/50",
  info: "bg-info/50",
} as const;

/** NexQ-style toast stack: spring entrance, accent rail, auto-dismiss bar. */
export function Toaster({ className }: { className?: string } = {}) {
  const toasts = useToastStore((s) => s.toasts);
  return (
    <div
      className={cn(
        "pointer-events-none fixed bottom-4 right-4 z-[60] flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2",
        className
      )}
    >
      {toasts.map((toast) => (
        <ToastRow key={toast.id} toast={toast} />
      ))}
    </div>
  );
}

function ToastRow({ toast }: { toast: ToastItem }) {
  const dismiss = useToastStore((s) => s.dismiss);
  const [exiting, setExiting] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const close = () => {
    if (exiting) return;
    setExiting(true);
    setTimeout(() => dismiss(toast.id), 260);
  };

  useEffect(() => {
    timer.current = setTimeout(close, 4200);
    return () => clearTimeout(timer.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const Icon = ICONS[toast.type];

  return (
    <div
      className={cn(
        "pointer-events-auto relative overflow-hidden rounded-lg border border-border border-l-2 bg-card/95 px-3 py-2.5 shadow-lg backdrop-blur-md",
        ACCENT[toast.type],
        exiting ? "toast-exit" : "toast-enter"
      )}
      role="status"
    >
      <div className="flex items-start gap-2.5">
        <span className={cn("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full", ICON_STYLE[toast.type])}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-foreground">{toast.title}</p>
          {toast.description && (
            <p className="mt-0.5 break-words text-[11px] leading-snug text-muted-foreground">
              {toast.description}
            </p>
          )}
        </div>
        <button
          type="button"
          onClick={close}
          className="rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          aria-label="Dismiss notification"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <span
        className={cn("toast-progress-bar absolute bottom-0 left-0 h-px w-full", PROGRESS[toast.type])}
      />
    </div>
  );
}

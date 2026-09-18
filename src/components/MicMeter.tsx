import { useEffect, useRef } from "react";
import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Input level meter, NexQ style: a rolling bar history driven by the mic RMS,
 * so the user can see that the right device is actually picking up sound.
 */
export function MicMeter({
  level,
  active,
  bars = 32,
  className,
}: {
  level: number;
  active: boolean;
  bars?: number;
  className?: string;
}) {
  const historyRef = useRef<number[]>(new Array(bars).fill(0));
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    historyRef.current = [...historyRef.current.slice(1), active ? level : 0];
    const container = containerRef.current;
    if (!container) return;
    const children = container.children;
    for (let i = 0; i < children.length; i += 1) {
      const bar = children[i] as HTMLElement;
      const value = historyRef.current[i] ?? 0;
      bar.style.transform = `scaleY(${Math.max(0.14, Math.min(1, value * 1.6))})`;
      bar.style.opacity = String(0.3 + Math.min(1, value * 2) * 0.7);
    }
  }, [level, active]);

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-md border",
          active
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-muted/30 text-muted-foreground"
        )}
      >
        <Mic className={cn("h-3.5 w-3.5", active && "animate-pulse")} />
      </span>
      <div ref={containerRef} className="flex h-6 flex-1 items-center gap-[2px]" aria-hidden>
        {Array.from({ length: bars }).map((_, i) => (
          <span
            key={i}
            className="h-full flex-1 origin-center rounded-full bg-gradient-to-t from-primary/40 via-primary/70 to-primary transition-transform duration-100"
            style={{ transform: "scaleY(0.14)" }}
          />
        ))}
      </div>
    </div>
  );
}

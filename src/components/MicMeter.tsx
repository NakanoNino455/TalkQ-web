import { useEffect, useRef } from "react";
import { Mic } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Input level meter, far-field aware.
 *
 * The old version mapped RMS through a magic multiplier, so a 5 m voice
 * (RMS ≈ 0.004 → bar at 1.8%) looked like a dead microphone and told the user
 * nothing. This one works in dBFS on a fixed -80..0 scale and draws the learned
 * noise floor as a marker: if the speech bars barely rise above that line, the
 * signal is not usable no matter what the software does.
 */
export function MicMeter({
  level,
  active,
  bars = 32,
  noiseFloorDb,
  snrDb,
  speech,
  clipping,
  className,
}: {
  /** 0..1 display level (already dB-mapped). */
  level: number;
  active: boolean;
  bars?: number;
  noiseFloorDb?: number | null;
  snrDb?: number | null;
  speech?: boolean;
  clipping?: boolean;
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
      // Minimum visible height so a silent meter still reads as a meter.
      bar.style.transform = `scaleY(${Math.max(0.1, Math.min(1, value))})`;
      bar.style.opacity = String(0.3 + Math.min(1, value * 1.6) * 0.7);
    }
  }, [level, active]);

  // Where the noise floor sits on the same 0..1 scale (-80..0 dBFS).
  const floorPercent =
    noiseFloorDb === null || noiseFloorDb === undefined
      ? null
      : Math.max(0, Math.min(100, ((noiseFloorDb + 80) / 80) * 100));

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <span
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-md border transition-colors",
          speech
            ? "border-success/50 bg-success/15 text-success"
            : active
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-muted/30 text-muted-foreground"
        )}
        title={speech ? "检测到人声" : active ? "正在聆听（未检测到人声）" : "麦克风未开启"}
      >
        <Mic className={cn("h-3.5 w-3.5", active && "animate-pulse")} />
      </span>

      <div className="min-w-0 flex-1">
        <div ref={containerRef} className="relative flex h-6 items-center gap-[2px]" aria-hidden>
          {Array.from({ length: bars }).map((_, i) => (
            <span
              key={i}
              className={cn(
                "h-full flex-1 origin-center rounded-full bg-gradient-to-t transition-transform duration-100",
                speech ? "from-success/40 via-success/70 to-success" : "from-primary/40 via-primary/70 to-primary"
              )}
              style={{ transform: "scaleY(0.1)" }}
            />
          ))}

          {floorPercent !== null && (
            <span
              className="pointer-events-none absolute top-0 h-full w-px bg-warning/70"
              style={{ left: `${floorPercent}%` }}
              title={`噪声底 ${noiseFloorDb?.toFixed(1)} dBFS`}
            />
          )}
        </div>

        <div className="mt-0.5 flex items-center gap-2 text-meta text-muted-foreground/70">
          <span className="font-mono">-80</span>
          <span className="ml-auto flex items-center gap-2">
            {snrDb !== null && snrDb !== undefined && (
              <span
                className={cn(
                  snrDb >= 12 ? "text-success" : snrDb >= 6 ? "text-warning" : "text-destructive"
                )}
              >
                SNR {snrDb.toFixed(0)} dB
              </span>
            )}
            {clipping && <span className="text-destructive">削波</span>}
          </span>
          <span className="font-mono">0 dBFS</span>
        </div>
      </div>
    </div>
  );
}

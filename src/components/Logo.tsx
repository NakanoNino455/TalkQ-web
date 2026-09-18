import { cn } from "@/lib/utils";

/** NexQ wordmark + glyph, reused across the sidebar, modal and empty state. */
export function Logo({
  className,
  size = 28,
  withWordmark = true,
  subtitle,
}: {
  className?: string;
  size?: number;
  withWordmark?: boolean;
  subtitle?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className="relative grid shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary to-[hsl(220_80%_45%)] glow-primary-strong"
        style={{ width: size, height: size }}
        aria-hidden
      >
        <span
          className="font-semibold leading-none text-primary-foreground"
          style={{ fontSize: size * 0.52 }}
        >
          N
        </span>
      </div>
      {withWordmark && (
        <div className="leading-none">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">NexQ</div>
          {subtitle && (
            <div className="mt-0.5 text-meta uppercase tracking-[0.18em] text-muted-foreground">
              {subtitle}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

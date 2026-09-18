import { cn } from "@/lib/utils";

/**
 * TalkQ mark: the app icon (generated from the source artwork by
 * `npm run icons`) next to the wordmark. If the image cannot be loaded — e.g.
 * the single-file build opened straight from disk — it falls back to the
 * gradient letter tile so the header never shows a broken image.
 */
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
  const iconSrc = `${import.meta.env.BASE_URL}icon-192.png`;

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <img
        src={iconSrc}
        width={size}
        height={size}
        alt=""
        aria-hidden
        className="shrink-0 rounded-[10px] border border-white/10 object-cover glow-primary-strong"
        style={{ width: size, height: size }}
        onError={(event) => {
          // Fallback: swap in the gradient tile rendered below.
          const img = event.currentTarget;
          img.style.display = "none";
          const fallback = img.nextElementSibling as HTMLElement | null;
          if (fallback) fallback.style.display = "grid";
        }}
      />
      <div
        className="relative hidden shrink-0 place-items-center rounded-[10px] bg-gradient-to-br from-primary to-[hsl(220_80%_45%)] glow-primary-strong"
        style={{ width: size, height: size, display: "none" }}
        aria-hidden
      >
        <span
          className="font-semibold leading-none text-primary-foreground"
          style={{ fontSize: size * 0.52 }}
        >
          T
        </span>
      </div>

      {withWordmark && (
        <div className="leading-none">
          <div className="text-[15px] font-semibold tracking-tight text-foreground">TalkQ</div>
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

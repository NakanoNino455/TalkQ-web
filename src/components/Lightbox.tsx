import { useEffect } from "react";
import { X } from "lucide-react";
import { useLightboxStore } from "@/stores/lightboxStore";

/** Full-screen image viewer for attachments (click a thumbnail to open). */
export function Lightbox() {
  const src = useLightboxStore((s) => s.src);
  const caption = useLightboxStore((s) => s.caption);
  const close = useLightboxStore((s) => s.close);

  useEffect(() => {
    if (!src) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [src, close]);

  if (!src) return null;

  return (
    <div
      className="fade-in fixed inset-0 z-[70] flex flex-col items-center justify-center gap-3 bg-background/90 p-6 backdrop-blur-md"
      onClick={close}
      role="dialog"
      aria-modal="true"
      aria-label="Image preview"
    >
      <button
        type="button"
        onClick={close}
        className="absolute right-4 top-4 rounded-md border border-border bg-card/70 p-2 text-muted-foreground transition-colors hover:text-foreground"
        aria-label="Close preview"
      >
        <X className="h-4 w-4" />
      </button>
      <img
        src={src}
        alt={caption ?? "Attached image"}
        className="max-h-[82vh] max-w-[92vw] rounded-xl border border-border object-contain shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      />
      {caption && <p className="text-[11px] text-muted-foreground">{caption}</p>}
    </div>
  );
}

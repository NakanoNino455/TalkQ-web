import { ImageOff, X } from "lucide-react";
import type { ImageAttachment } from "@/types";
import { cn, formatBytes } from "@/lib/utils";
import { useLightboxStore } from "@/stores/lightboxStore";

/**
 * Draft attachments shown above the input:
 *
 *   ┌──────────┐
 *   │  image   │ ×
 *   └──────────┘
 *
 * Remove one, or add more — multi-image is fully supported.
 */
export function ImageStrip({
  images,
  onRemove,
  className,
}: {
  images: ImageAttachment[];
  onRemove: (id: string) => void;
  className?: string;
}) {
  const openLightbox = useLightboxStore((s) => s.open);

  if (images.length === 0) return null;

  return (
    <div className={cn("flex flex-wrap items-end gap-2 px-1 pb-2", className)}>
      {images.map((image) => (
        <div
          key={image.id}
          className="slide-up group relative overflow-hidden rounded-lg border border-border bg-muted/30"
        >
          <button
            type="button"
            onClick={() => openLightbox(image.dataUrl, image.name)}
            className="block"
            title={`${image.name} · ${formatBytes(image.size)}`}
            aria-label={`Preview ${image.name}`}
          >
            {image.dataUrl ? (
              <img
                src={image.dataUrl}
                alt={image.name}
                className="h-16 w-16 object-cover transition-transform duration-200 group-hover:scale-105"
              />
            ) : (
              <span className="grid h-16 w-16 place-items-center text-muted-foreground">
                <ImageOff className="h-4 w-4" />
              </span>
            )}
          </button>

          <button
            type="button"
            onClick={() => onRemove(image.id)}
            className="absolute right-0.5 top-0.5 rounded-full border border-border bg-background/85 p-0.5 text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
            aria-label={`Remove ${image.name}`}
            title="Remove image"
          >
            <X className="h-3 w-3" />
          </button>

          <div className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-background/80 px-1 py-0.5 text-[9px] text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100">
            {image.width && image.height ? `${image.width}×${image.height}` : image.mime.split("/")[1]}
          </div>
        </div>
      ))}
    </div>
  );
}

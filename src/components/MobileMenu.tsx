import { useEffect, useRef, useState } from "react";
import {
  ClipboardCopy,
  ArrowDownToLine,
  MoreHorizontal,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

/** Small overflow menu used by the mobile control bar. */
export function MobileMenu({
  onCopyAll,
  onExport,
  onClear,
  livePreview,
  onTogglePreview,
  quickMode,
  onToggleQuickMode,
  disabled,
}: {
  onCopyAll: () => void;
  onExport: () => void;
  onClear: () => void;
  livePreview: boolean;
  onTogglePreview: () => void;
  quickMode: boolean;
  onToggleQuickMode: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label="更多操作"
        aria-expanded={open}
        className={cn(
          "touch-target grid place-items-center rounded-lg border border-border transition-colors",
          open ? "bg-accent text-foreground" : "bg-background/60 text-muted-foreground"
        )}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>

      {open && (
        <div className="slide-up absolute right-0 top-[calc(100%+0.4rem)] z-40 w-56 overflow-hidden rounded-xl border border-border bg-card/95 shadow-xl backdrop-blur-xl">
          <MenuItem
            icon={<Sparkles className="h-4 w-4" />}
            label="实时预览译文"
            hint={livePreview ? "已开启" : "已关闭"}
            active={livePreview}
            onClick={() => {
              onTogglePreview();
              setOpen(false);
            }}
          />
          <MenuItem
            icon={<Zap className="h-4 w-4" />}
            label="低延迟模式"
            hint={quickMode ? "已开启" : "已关闭"}
            active={quickMode}
            onClick={() => {
              onToggleQuickMode();
              setOpen(false);
            }}
          />
          <div className="my-1 h-px bg-border" />
          <MenuItem
            icon={<ClipboardCopy className="h-4 w-4" />}
            label="复制全部字幕"
            disabled={disabled}
            onClick={() => {
              onCopyAll();
              setOpen(false);
            }}
          />
          <MenuItem
            icon={<ArrowDownToLine className="h-4 w-4" />}
            label="导出 .txt"
            disabled={disabled}
            onClick={() => {
              onExport();
              setOpen(false);
            }}
          />
          <MenuItem
            icon={<Trash2 className="h-4 w-4" />}
            label="清空字幕"
            danger
            disabled={disabled}
            onClick={() => {
              onClear();
              setOpen(false);
            }}
          />
        </div>
      )}
    </div>
  );
}

function MenuItem({
  icon,
  label,
  hint,
  active,
  danger,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex w-full items-center gap-2.5 px-3.5 py-3 text-left text-[13px] transition-colors disabled:opacity-40",
        danger
          ? "text-destructive hover:bg-destructive/10"
          : active
            ? "text-primary hover:bg-accent"
            : "text-foreground/90 hover:bg-accent"
      )}
    >
      <span className={cn(danger ? "text-destructive" : active ? "text-primary" : "text-muted-foreground")}>
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

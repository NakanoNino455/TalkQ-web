import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ClipboardCopy,
  MoreHorizontal,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Mobile overflow menu.
 *
 * Rendered as a bottom sheet through a portal on <body>: the control bar uses
 * `backdrop-blur`, which creates a stacking context — a dropdown living inside
 * it was painted *under* the subtitle list (visually visible but not tappable).
 * A portal sidesteps that entirely, and a sheet is easier to hit with a thumb.
 */
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

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const close = () => setOpen(false);
  const run = (action: () => void) => () => {
    setOpen(false);
    // Let the sheet close before a confirm() dialog steals the interaction.
    setTimeout(action, 0);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="更多操作"
        aria-expanded={open}
        className={cn(
          "touch-target grid place-items-center rounded-lg border border-border transition-colors",
          open ? "bg-accent text-foreground" : "bg-background/60 text-muted-foreground"
        )}
      >
        <MoreHorizontal className="h-5 w-5" />
      </button>

      {open &&
        createPortal(
          <div className="fixed inset-0 z-[70]" role="dialog" aria-label="更多操作">
            <div
              className="absolute inset-0 bg-background/70 backdrop-blur-sm"
              onClick={close}
              aria-hidden
            />
            <div className="pb-safe slide-up absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-card/95 shadow-2xl backdrop-blur-xl">
              <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-muted-foreground/30" />
              <div className="px-2 pb-2 pt-2">
                <SheetItem
                  icon={<Sparkles className="h-4 w-4" />}
                  label="实时预览译文"
                  hint={livePreview ? "已开启" : "已关闭"}
                  active={livePreview}
                  onClick={run(onTogglePreview)}
                />
                <SheetItem
                  icon={<Zap className="h-4 w-4" />}
                  label="低延迟模式"
                  hint={quickMode ? "已开启" : "已关闭"}
                  active={quickMode}
                  onClick={run(onToggleQuickMode)}
                />
                <div className="my-1.5 h-px bg-border" />
                <SheetItem
                  icon={<ClipboardCopy className="h-4 w-4" />}
                  label="复制全部字幕"
                  disabled={disabled}
                  onClick={run(onCopyAll)}
                />
                <SheetItem
                  icon={<ArrowDownToLine className="h-4 w-4" />}
                  label="导出 .txt"
                  disabled={disabled}
                  onClick={run(onExport)}
                />
                <SheetItem
                  icon={<Trash2 className="h-4 w-4" />}
                  label="清空字幕"
                  danger
                  disabled={disabled}
                  onClick={run(onClear)}
                />
                <button
                  type="button"
                  onClick={close}
                  className="mt-1.5 w-full rounded-xl border border-border bg-background/60 py-3 text-[13px] text-muted-foreground active:bg-accent"
                >
                  取消
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
}

function SheetItem({
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
        "flex w-full items-center gap-3 rounded-xl px-3 py-3.5 text-left text-[14px] transition-colors disabled:opacity-40",
        danger
          ? "text-destructive active:bg-destructive/10"
          : active
            ? "text-primary active:bg-accent"
            : "text-foreground/90 active:bg-accent"
      )}
    >
      <span
        className={cn(
          danger ? "text-destructive" : active ? "text-primary" : "text-muted-foreground"
        )}
      >
        {icon}
      </span>
      <span className="flex-1">{label}</span>
      {hint && <span className="text-[11px] text-muted-foreground">{hint}</span>}
    </button>
  );
}

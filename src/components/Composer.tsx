import { useCallback, useEffect, useRef, useState } from "react";
import {
  CornerDownLeft,
  FileUp,
  ImagePlus,
  Loader2,
  SendHorizontal,
  ShieldCheck,
  Square,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { DocumentStrip } from "./DocumentStrip";
import { ImageStrip } from "./ImageStrip";
import { ACCEPT_ATTR, DEEPSEEK_MODEL, IMAGE_LIMITS } from "@/lib/constants";
import { DOCUMENT_ACCEPT, extractDocuments } from "@/lib/documents";
import { attachmentsFromFiles, imageFilesFromClipboard, imageFilesFromDrop } from "@/lib/images";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/stores/chatStore";
import { useSettingsStore } from "@/stores/settingsStore";
import { showToast } from "@/stores/toastStore";

/**
 * Composer: text, image attachments (button / drag & drop / Ctrl+V paste),
 * send, and the "Stop generating" abort control.
 */
export function Composer({
  variant = "full",
  onSendOverride,
}: {
  /** "panel" is the embedded ask sidebar: tighter chrome, fewer hints. */
  variant?: "full" | "panel";
  /** When set, sending goes through the caller (so it can attach context). */
  onSendOverride?: () => void;
} = {}) {
  const compact = variant === "panel";
  const draft = useChatStore((s) => s.draft);
  const setDraft = useChatStore((s) => s.setDraft);
  const draftImages = useChatStore((s) => s.draftImages);
  const draftDocuments = useChatStore((s) => s.draftDocuments);
  const addDraftDocuments = useChatStore((s) => s.addDraftDocuments);
  const removeDraftDocument = useChatStore((s) => s.removeDraftDocument);
  const addDraftImages = useChatStore((s) => s.addDraftImages);
  const removeDraftImage = useChatStore((s) => s.removeDraftImage);
  const send = useChatStore((s) => s.send);
  const stop = useChatStore((s) => s.stop);
  const isStreaming = useChatStore((s) => s.isStreaming);

  const apiKey = useSettingsStore((s) => s.apiKey);
  const sendOnEnter = useSettingsStore((s) => s.settings.sendOnEnter);

  const [dragActive, setDragActive] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const [readingDocs, setReadingDocs] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const docInputRef = useRef<HTMLInputElement>(null);

  const hasPayload =
    draft.trim().length > 0 || draftImages.length > 0 || draftDocuments.length > 0;
  const canSend = hasPayload && !isStreaming && Boolean(apiKey);

  /* Auto-grow the textarea (1 → 8 rows). */
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [draft]);

  const attach = useCallback(
    async (files: File[] | Blob[]) => {
      if (files.length === 0) return;
      setAttaching(true);
      try {
        const { attachments, errors } = await attachmentsFromFiles(files);
        if (attachments.length > 0) addDraftImages(attachments);
        for (const message of errors) showToast("error", "Image not attached", message);
      } finally {
        setAttaching(false);
      }
    },
    [addDraftImages]
  );

  const attachDocuments = useCallback(
    async (files: File[]) => {
      if (files.length === 0) return;
      setReadingDocs(true);
      try {
        const { documents, errors } = await extractDocuments(files);
        if (documents.length > 0) {
          addDraftDocuments(documents);
          showToast(
            "success",
            `已读取 ${documents.length} 个文档`,
            documents.map((doc) => `${doc.name} · ${doc.chars} 字`).join("；")
          );
        }
        for (const message of errors) showToast("error", "文档读取失败", message);      } finally {
        setReadingDocs(false);
      }
    },
    [addDraftDocuments]
  );

  /* Ctrl+V — screenshots copied with Win+Shift+S land here. */
  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as Node | null;
      const container = containerRef.current;
      const insideComposer =
        !target || target === document.body || (container ? container.contains(target) : false);
      if (!insideComposer) return;

      const files = imageFilesFromClipboard(event.clipboardData);
      if (files.length === 0) return;

      event.preventDefault();
      void attach(files);
      showToast(
        "success",
        files.length > 1 ? `${files.length} images attached` : "Image attached",
        "Press Send when you're ready."
      );
    };

    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, [attach]);

  const handleDrop = async (event: React.DragEvent) => {
    event.preventDefault();
    setDragActive(false);
    const files = imageFilesFromDrop(event.dataTransfer);
    if (files.length === 0) {
      showToast(
        "error",
        "Unsupported drop",
        `Only ${IMAGE_LIMITS.formatLabels} images can be attached.`
      );
      return;
    }
    await attach(files);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter") return;
    const wantsSend = sendOnEnter ? !event.shiftKey : event.metaKey || event.ctrlKey;
    if (!wantsSend) return;
    event.preventDefault();
    if (!canSend) return;
    if (onSendOverride) onSendOverride();
    else void send();
  };

  const triggerSend = () => {
    if (!canSend) return;
    if (onSendOverride) onSendOverride();
    else void send();
  };

  return (
    <div className={cn("dash-composer shrink-0", compact ? "px-2.5 pb-2.5 pt-1" : "px-3 pb-4 pt-1 sm:px-6")}>
      <div
        ref={containerRef}
        onDragOver={(e) => {
          e.preventDefault();
          setDragActive(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget.contains(e.relatedTarget as Node)) return;
          setDragActive(false);
        }}
        onDrop={handleDrop}
        className={cn(
          "mx-auto w-full rounded-2xl border border-border bg-card/70 p-2 backdrop-blur-xl transition-colors",
          compact ? "max-w-none" : "max-w-chat",
          "focus-within:border-primary/40 focus-within:glow-primary",
          dragActive && "dropzone-active"
        )}
      >
        <ImageStrip images={draftImages} onRemove={removeDraftImage} />
        <DocumentStrip
          documents={draftDocuments}
          onRemove={removeDraftDocument}
          busy={readingDocs}
        />

        <div className="relative">
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            disabled={!apiKey}
            placeholder={
              apiKey
                ? compact
                  ? "粘贴问题，回车发送…"
                  : "Message DeepSeek Flash…  (drag, paste or upload images)"
                : "Add your DeepSeek API key to start chatting"
            }
            className={cn(
              "max-h-[200px] w-full resize-none bg-transparent px-2 py-2 text-[13.5px] leading-relaxed text-foreground",
              "placeholder:text-muted-foreground/60 focus:outline-none disabled:cursor-not-allowed"
            )}
          />
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 grid place-items-center rounded-lg bg-primary/5">
              <span className="rounded-full border border-primary/40 bg-background/85 px-3 py-1 text-[11px] text-primary">
                Drop images to attach
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 px-1 pt-1">
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPT_ATTR}
            multiple
            className="hidden"
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []);
              await attach(files);
              event.target.value = "";
            }}
          />

          <Button
            variant="ghost"
            size="icon"
            onClick={() => fileInputRef.current?.click()}
            disabled={!apiKey || attaching}
            title={`附加图片（${IMAGE_LIMITS.formatLabels}）`}
            aria-label="附加图片"
          >
            {attaching ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ImagePlus className="h-4 w-4" />
            )}
          </Button>

          <input
            ref={docInputRef}
            type="file"
            accept={DOCUMENT_ACCEPT}
            multiple
            className="hidden"
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = "";
              await attachDocuments(files);
            }}
          />

          <Button
            variant="ghost"
            size="icon"
            onClick={() => docInputRef.current?.click()}
            disabled={!apiKey || readingDocs}
            title="上传文档（PDF / TXT / DOCX），内容会随提问一起发送"
            aria-label="上传文档"
          >
            {readingDocs ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <FileUp className="h-4 w-4" />
            )}
          </Button>

          {!compact && (
            <span className="hidden items-center gap-1.5 text-meta text-muted-foreground/70 sm:flex">
              <ShieldCheck className="h-3 w-3" />
              key stays in this browser
            </span>
          )}

          <div className="flex-1" />

          {!compact && (
            <span className="hidden items-center gap-1 text-meta text-muted-foreground/60 md:flex">
              <CornerDownLeft className="h-3 w-3" />
              {sendOnEnter ? "Enter to send · Shift+Enter newline" : "Ctrl+Enter to send"}
            </span>
          )}

          {isStreaming ? (
            <Button variant="destructive" size="md" onClick={stop} className="gap-2">
              <Square className="h-3.5 w-3.5" />
              {compact ? "停止" : "Stop generating"}
            </Button>
          ) : (
            <Button
              variant="primary"
              size="md"
              onClick={triggerSend}
              disabled={!canSend}
              className="gap-2"
            >
              <SendHorizontal className="h-3.5 w-3.5" />
              发送
            </Button>
          )}
        </div>
      </div>

      {!compact && (
        <p className="mx-auto mt-1.5 max-w-chat px-2 text-center text-meta text-muted-foreground/60">
          {DEEPSEEK_MODEL} · {IMAGE_LIMITS.formatLabels} up to 32 MB each · conversation history is
          kept in full for the 1M context window
        </p>
      )}
    </div>
  );
}

import type { ImageAttachment } from "@/types";
import { DEFAULT_IMAGE_PROMPT, IMAGE_LIMITS } from "./constants";
import { DeepSeekError } from "./errors";
import { uid } from "./utils";

/**
 * Image pipeline — 100% browser-side.
 *
 * Files picked, dropped or pasted (Win+Shift+S → Ctrl+V) are validated,
 * converted to `data:image/...;base64,...` and attached to the next message.
 * Nothing is uploaded to any server by this module.
 */

const SIGNATURES: Array<{ mime: string; match: (bytes: Uint8Array) => boolean }> = [
  { mime: "image/jpeg", match: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    mime: "image/png",
    match: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  },
  { mime: "image/gif", match: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 },
  {
    mime: "image/webp",
    match: (b) =>
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50,
  },
];

export function sniffImageMime(bytes: Uint8Array): string | null {
  for (const sig of SIGNATURES) {
    if (sig.match(bytes)) return sig.mime;
  }
  return null;
}

export function isSupportedImageType(type: string): boolean {
  return (IMAGE_LIMITS.formats as readonly string[]).includes(type);
}

function unsupportedError(name: string, detail: string): DeepSeekError {
  return new DeepSeekError({
    kind: "invalid_request",
    title: "Unsupported Image",
    detail: `${name}: ${detail}`,
    hint: `DeepSeek Flash accepts ${IMAGE_LIMITS.formatLabels} images up to ${Math.round(
      IMAGE_LIMITS.maxFileBytes / (1024 * 1024)
    )} MB each.`,
  });
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"));
    reader.readAsDataURL(file);
  });
}

async function readBytes(file: Blob, count = 16): Promise<Uint8Array> {
  const slice = file.slice(0, count);
  const buffer = await slice.arrayBuffer();
  return new Uint8Array(buffer);
}

async function measure(dataUrl: string): Promise<{ width?: number; height?: number }> {
  if (typeof createImageBitmap === "function") {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);
      const size = { width: bitmap.width, height: bitmap.height };
      bitmap.close?.();
      return size;
    } catch {
      /* fall through to <img> */
    }
  }
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth, height: img.naturalHeight });
    img.onerror = () => resolve({});
    img.src = dataUrl;
  });
}

/** Validate + normalise one file/blob into an attachable image. */
export async function attachmentFromBlob(blob: Blob, name: string): Promise<ImageAttachment> {
  if (blob.size <= 0) throw unsupportedError(name, "the file is empty");
  if (blob.size > IMAGE_LIMITS.maxFileBytes) {
    throw unsupportedError(
      name,
      `image is ${(blob.size / (1024 * 1024)).toFixed(1)} MB, over the 32 MB limit`
    );
  }

  // DeepSeek detects the format from the bytes, so validate the bytes too.
  const head = await readBytes(blob);
  const sniffed = sniffImageMime(head);
  if (!sniffed) {
    const declared = blob.type || "unknown type";
    throw unsupportedError(name, `not a readable ${IMAGE_LIMITS.formatLabels} image (${declared})`);
  }

  const dataUrl = await readAsDataUrl(blob);
  if (!dataUrl.startsWith("data:")) {
    throw unsupportedError(name, "the browser could not encode this file");
  }

  const { width, height } = await measure(dataUrl);
  return {
    id: uid("img"),
    name: name || `pasted-image.${sniffed.split("/")[1]}`,
    mime: sniffed,
    size: blob.size,
    dataUrl,
    width,
    height,
  };
}

export async function attachmentsFromFiles(files: Iterable<File | Blob>): Promise<{
  attachments: ImageAttachment[];
  errors: string[];
}> {
  const attachments: ImageAttachment[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const name = (file as File).name ?? "image";
    try {
      attachments.push(await attachmentFromBlob(file, name));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `${name}: could not be attached`);
    }
  }
  return { attachments, errors };
}

/** Pull every image out of a paste event's clipboard payload. */
export function imageFilesFromClipboard(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];

  const items = data.items ? Array.from(data.items) : [];
  for (const item of items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (!file) continue;
    if (file.type.startsWith("image/") || sniffedFromName(file.name)) out.push(file);
  }

  if (out.length === 0 && data.files) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith("image/")) out.push(file);
    }
  }
  return out;
}

/** Images from a drag & drop payload (files, then item fallback). */
export function imageFilesFromDrop(data: DataTransfer | null): File[] {
  if (!data) return [];
  const out: File[] = [];
  if (data.files?.length) {
    for (const file of Array.from(data.files)) {
      if (file.type.startsWith("image/") || sniffedFromName(file.name)) out.push(file);
    }
  }
  if (out.length === 0 && data.items?.length) {
    for (const item of Array.from(data.items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file && (file.type.startsWith("image/") || sniffedFromName(file.name))) out.push(file);
      }
    }
  }
  return out;
}

function sniffedFromName(name: string): boolean {
  return /\.(png|jpe?g|gif|webp)$/i.test(name);
}

/** Size on the wire for a data URL (base64 payload only). */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return dataUrl.length;
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Guard the 48 MiB request-body limit before we waste a round trip. */
export function assertBodyBudget(images: ImageAttachment[]): void {
  const total = images.reduce((sum, img) => sum + dataUrlBytes(img.dataUrl), 0);
  if (total > IMAGE_LIMITS.maxBodyBytes * 0.9) {
    throw new DeepSeekError({
      kind: "invalid_request",
      title: "Images Too Large For One Request",
      detail: `Attachments total ${(total / (1024 * 1024)).toFixed(1)} MB; DeepSeek accepts up to 48 MB per request.`,
      hint: "Remove an image or send them in separate messages.",
    });
  }
  if (images.length > IMAGE_LIMITS.maxPerRequest) {
    throw new DeepSeekError({
      kind: "invalid_request",
      title: "Too Many Images",
      detail: `${images.length} images attached; DeepSeek accepts up to ${IMAGE_LIMITS.maxPerRequest} per request.`,
    });
  }
}

export function composeUserText(text: string, imageCount: number): string {
  const trimmed = text.trim();
  if (trimmed) return trimmed;
  return imageCount > 0 ? DEFAULT_IMAGE_PROMPT : "";
}

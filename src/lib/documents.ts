import type { DocumentAttachment, DocumentKind } from "@/types";
import { DeepSeekError } from "./errors";
import { uid } from "./utils";

/**
 * Read PDF / TXT / DOCX files entirely in the browser and turn them into plain
 * text that can ride along with a question.
 *
 *   TXT   — TextDecoder, UTF-8 first with a GBK fallback (Chinese Windows files)
 *   DOCX  — it is a ZIP: inflate word/document.xml with the browser's own
 *           DecompressionStream and strip the markup (no library needed)
 *   PDF   — pdf.js, loaded lazily so the initial bundle stays small
 *
 * Nothing is uploaded anywhere: the file never leaves this tab.
 */

export const DOCUMENT_ACCEPT =
  ".pdf,.txt,.docx,application/pdf,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export const DOCUMENT_LIMITS = {
  maxFileBytes: 20 * 1024 * 1024,
  /** Per document. ~120k chars is roughly 40–60k tokens. */
  maxCharsPerDoc: 120_000,
  maxDocs: 5,
  /** Total text sent with one question. */
  maxTotalChars: 240_000,
  maxPdfPages: 80,
};

export function detectDocumentKind(file: File): DocumentKind | null {
  const name = file.name.toLowerCase();
  if (name.endsWith(".pdf") || file.type === "application/pdf") return "pdf";
  if (name.endsWith(".docx")) return "docx";
  if (name.endsWith(".txt") || file.type === "text/plain") return "txt";
  return null;
}

function unsupported(detail: string): DeepSeekError {
  return new DeepSeekError({
    kind: "invalid_request",
    title: "Unsupported document",
    detail,
    hint: "支持 PDF、TXT、DOCX 三种格式（旧版 .doc 请先另存为 .docx）。",
  });
}

/** Cut to the per-document limit, flagging the truncation. */
function clampText(text: string): { text: string; truncated: boolean } {
  const clean = text.replace(/\r\n?/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  if (clean.length <= DOCUMENT_LIMITS.maxCharsPerDoc) {
    return { text: clean, truncated: false };
  }
  return {
    text: `${clean.slice(0, DOCUMENT_LIMITS.maxCharsPerDoc)}\n\n…（文档过长，已截断）`,
    truncated: true,
  };
}

/* ── TXT ─────────────────────────────────────────────────────────────── */

async function readPlainText(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // UTF-8 with BOM?
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(bytes.subarray(3));
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    // Chinese Windows text files are usually GBK.
    for (const encoding of ["gbk", "big5", "utf-16le"]) {
      try {
        const decoded = new TextDecoder(encoding, { fatal: true }).decode(bytes);
        if (decoded.trim()) return decoded;
      } catch {
        /* try the next one */
      }
    }
    return new TextDecoder("utf-8").decode(bytes);
  }
}

/* ── DOCX (ZIP + word/document.xml) ──────────────────────────────────── */

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Minimal ZIP reader: enough for the single entry we need out of a .docx. */
async function readZipEntry(buffer: ArrayBuffer, wantedName: string): Promise<Uint8Array | null> {
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // Locate the End Of Central Directory record (last 66k at most).
  let eocd = -1;
  const start = Math.max(0, bytes.length - 66_000);
  for (let i = bytes.length - 22; i >= start; i -= 1) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw unsupported("这不是一个有效的 .docx（找不到 ZIP 目录）。");

  const entryCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder("utf-8");

  for (let i = 0; i < entryCount; i += 1) {
    if (view.getUint32(offset, true) !== SIG_CENTRAL) break;
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));

    if (name === wantedName) {
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const data = bytes.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw unsupported(`.docx 使用了不支持的压缩方式（method ${method}）。`);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return null;
}

function docxXmlToText(xml: string): string {
  return xml
    .replace(/<w:tab\b[^>]*\/?>/g, "\t")
    .replace(/<w:br\b[^>]*\/?>/g, "\n")
    .replace(/<\/w:p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

async function readDocx(file: File): Promise<{ text: string; note?: string }> {
  const buffer = await file.arrayBuffer();
  const entry = await readZipEntry(buffer, "word/document.xml");
  if (!entry) throw unsupported("这个 .docx 里没有 word/document.xml，可能不是 Word 文档。");
  const xml = new TextDecoder("utf-8").decode(entry);
  const text = docxXmlToText(xml);
  return {
    text,
    note: text.trim() ? undefined : "文档里没有可提取的文字（可能全是图片）。",
  };
}

/* ── PDF (pdf.js, lazily imported) ───────────────────────────────────── */

interface PdfTextItem {
  str?: string;
  transform?: number[];
  hasEOL?: boolean;
}

async function readPdf(file: File): Promise<{ text: string; pages: number; note?: string }> {
  let pdfjs: typeof import("pdfjs-dist");
  try {
    pdfjs = await import("pdfjs-dist");
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  } catch (err) {
    throw new DeepSeekError({
      kind: "network",
      title: "PDF 解析器加载失败",
      detail: err instanceof Error ? err.message : String(err),
      hint: "PDF 解析用的是按需加载的 pdf.js；单文件（file://）版本无法加载它，请用线上地址或改用 TXT/DOCX。",
    });
  }

  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjs.getDocument({ data });
  const pdf = await task.promise;

  try {
    const pageCount = pdf.numPages;
    const limit = Math.min(pageCount, DOCUMENT_LIMITS.maxPdfPages);
    const lines: string[] = [];

    for (let pageNumber = 1; pageNumber <= limit; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      let lastY: number | null = null;
      let line = "";

      for (const raw of content.items as PdfTextItem[]) {
        if (typeof raw.str !== "string") continue;
        const y = raw.transform?.[5] ?? 0;
        if (lastY !== null && Math.abs(y - lastY) > 2 && line.trim()) {
          lines.push(line.trim());
          line = "";
        }
        line += raw.str;
        if (raw.hasEOL && line.trim()) {
          lines.push(line.trim());
          line = "";
        }
        lastY = y;
      }
      if (line.trim()) lines.push(line.trim());
      lines.push("");
      page.cleanup();
    }

    const text = lines.join("\n").trim();
    return {
      text,
      pages: pageCount,
      note: text
        ? pageCount > limit
          ? `文档共 ${pageCount} 页，只提取了前 ${limit} 页。`
          : undefined
        : "没有提取到文字：这可能是扫描版/图片型 PDF。",
    };
  } finally {
    // Release the worker/parsed structures for this file.
    void task.destroy();
  }
}

/* ── Public API ──────────────────────────────────────────────────────── */

export async function extractDocument(file: File): Promise<DocumentAttachment> {
  const kind = detectDocumentKind(file);
  if (!kind) throw unsupported(`${file.name}：不认识的扩展名。`);
  if (file.size <= 0) throw unsupported(`${file.name}：文件是空的。`);
  if (file.size > DOCUMENT_LIMITS.maxFileBytes) {
    throw unsupported(
      `${file.name}：${(file.size / (1024 * 1024)).toFixed(1)} MB，超过 20 MB 上限。`
    );
  }

  let raw = "";
  let pages: number | undefined;
  let note: string | undefined;

  if (kind === "txt") {
    raw = await readPlainText(file);
  } else if (kind === "docx") {
    const result = await readDocx(file);
    raw = result.text;
    note = result.note;
  } else {
    const result = await readPdf(file);
    raw = result.text;
    pages = result.pages;
    note = result.note;
  }

  const { text, truncated } = clampText(raw);
  if (!text) {
    throw new DeepSeekError({
      kind: "invalid_request",
      title: "文档里没有可用文字",
      detail: note ?? `${file.name} 提取后是空的。`,
      hint: "扫描版 PDF 或纯图片文档无法提取文字，可以改用截图 + 图片提问。",
    });
  }

  return {
    id: uid("doc"),
    name: file.name,
    kind,
    size: file.size,
    text,
    chars: text.length,
    pages,
    truncated,
    note,
  };
}

export async function extractDocuments(files: Iterable<File>): Promise<{
  documents: DocumentAttachment[];
  errors: string[];
}> {
  const documents: DocumentAttachment[] = [];
  const errors: string[] = [];
  for (const file of files) {
    try {
      documents.push(await extractDocument(file));
    } catch (err) {
      // Surface both the headline and the file-specific reason.
      if (err instanceof DeepSeekError) {
        errors.push(err.detail ? `${err.message} · ${err.detail}` : err.message);
      } else {
        errors.push(err instanceof Error ? err.message : `${file.name}: 读取失败`);
      }
    }
  }
  return { documents, errors };
}

/** Render attached documents as the context block sent with a question. */
export function buildDocumentsContext(documents: DocumentAttachment[]): string {
  if (documents.length === 0) return "";
  const parts = documents.map((doc) => {
    const meta = [
      doc.kind.toUpperCase(),
      doc.pages ? `${doc.pages} 页` : null,
      `${doc.chars} 字`,
      doc.truncated ? "已截断" : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return `### ${doc.name}（${meta}）\n${doc.text}`;
  });

  return [
    "【用户上传的文档】以下是用户随本次提问一起提供的文档内容，请结合它们回答；如与问题无关可忽略。",
    ...parts,
  ].join("\n\n");
}

export { clampText as clampDocumentText };

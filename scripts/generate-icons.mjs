/**
 * Generate the TalkQ icon set from one source image.
 *
 *   node scripts/generate-icons.mjs "C:\path\to\picture.jpg"
 *
 * Outputs into public/:
 *   favicon.ico            16 / 32 / 48 (PNG-compressed entries)
 *   favicon-32.png         small sizes are a tight face crop with rounded corners —
 *                          a full-body illustration turns to mush at 16–32px
 *   apple-touch-icon.png   180×180, full artwork (iOS masks it itself)
 *   icon-192.png           192×192, PWA / manifest
 *   icon-512.png           512×512, PWA / manifest
 *   site.webmanifest
 *
 * Needs the same optional tooling as the verification harnesses:
 *   npm i -D playwright-core
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

let chromium;
try {
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("This optional tool needs playwright-core:\n  npm i -D playwright-core");
  process.exit(2);
}

const DEFAULT_SOURCE = "C:\\Users\\Administrator\\Pictures\\general-profile-picture.jpg";
const source = process.argv[2] ?? DEFAULT_SOURCE;
if (!existsSync(source)) {
  console.error(`Source image not found: ${source}`);
  process.exit(1);
}

const root = path.resolve(import.meta.dirname, "..");
const publicDir = path.join(root, "public");
await mkdir(publicDir, { recursive: true });

const dataUrl = `data:image/jpeg;base64,${(await readFile(source)).toString("base64")}`;

/** Face-focused square, in normalised source coordinates (0..1). */
const FACE_CROP = { x: 0.25, y: 0.06, size: 0.5 };

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage();
await page.goto("about:blank");

/**
 * Draw once per size. `crop` selects the region; `radius` rounds the corners
 * (0 = square). Returns base64 PNG payloads.
 */
const rendered = await page.evaluate(
  async ({ src, faceCrop, jobs }) => {
    const img = new Image();
    img.src = src;
    await img.decode();

    const draw = (size, crop, radius) => {
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";

      if (radius > 0) {
        const r = size * radius;
        ctx.beginPath();
        ctx.moveTo(r, 0);
        ctx.arcTo(size, 0, size, size, r);
        ctx.arcTo(size, size, 0, size, r);
        ctx.arcTo(0, size, 0, 0, r);
        ctx.arcTo(0, 0, size, 0, r);
        ctx.closePath();
        ctx.clip();
      }

      const sx = crop ? crop.x * img.width : 0;
      const sy = crop ? crop.y * img.height : 0;
      const sw = crop ? crop.size * img.width : img.width;
      const sh = crop ? crop.size * img.height : img.height;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, size, size);
      return canvas.toDataURL("image/png").split(",")[1];
    };

    const out = {};
    for (const job of jobs) {
      out[job.key] = draw(job.size, job.crop ? faceCrop : null, job.radius ?? 0);
    }
    return out;
  },
  {
    src: dataUrl,
    faceCrop: FACE_CROP,
    jobs: [
      { key: "ico16", size: 16, crop: true, radius: 0.22 },
      { key: "ico32", size: 32, crop: true, radius: 0.22 },
      { key: "ico48", size: 48, crop: true, radius: 0.22 },
      { key: "favicon32", size: 32, crop: true, radius: 0.22 },
      { key: "apple180", size: 180, radius: 0 },
      { key: "icon192", size: 192, radius: 0 },
      { key: "icon512", size: 512, radius: 0 },
    ],
  }
);

await browser.close();

const toBuffer = (key) => Buffer.from(rendered[key], "base64");

/* ── ICO container with PNG entries (supported everywhere modern) ─────── */
function buildIco(entries) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(entries.length, 4);

  const directory = Buffer.alloc(16 * entries.length);
  let offset = 6 + 16 * entries.length;
  entries.forEach((entry, index) => {
    const at = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at);
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, at + 1);
    directory.writeUInt8(0, at + 2);
    directory.writeUInt8(0, at + 3);
    directory.writeUInt16LE(1, at + 4);
    directory.writeUInt16LE(32, at + 6);
    directory.writeUInt32LE(entry.buffer.length, at + 8);
    directory.writeUInt32LE(offset, at + 12);
    offset += entry.buffer.length;
  });

  return Buffer.concat([header, directory, ...entries.map((e) => e.buffer)]);
}

const ico = buildIco([
  { size: 16, buffer: toBuffer("ico16") },
  { size: 32, buffer: toBuffer("ico32") },
  { size: 48, buffer: toBuffer("ico48") },
]);

const manifest = {
  name: "TalkQ — 实时语音翻译",
  short_name: "TalkQ",
  description:
    "浏览器端实时语音翻译 + DeepSeek 客户端：麦克风 → 实时识别 → 流式双语字幕，可对字幕直接提问。",
  start_url: ".",
  scope: ".",
  display: "standalone",
  background_color: "#080c16",
  theme_color: "#080c16",
  icons: [
    { src: "icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
    { src: "icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

const files = [
  ["favicon.ico", ico],
  ["favicon-32.png", toBuffer("favicon32")],
  ["apple-touch-icon.png", toBuffer("apple180")],
  ["icon-192.png", toBuffer("icon192")],
  ["icon-512.png", toBuffer("icon512")],
  ["site.webmanifest", Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8")],
];

for (const [name, buffer] of files) {
  await writeFile(path.join(publicDir, name), buffer);
  console.log(`  ${name.padEnd(22)} ${(buffer.length / 1024).toFixed(1)} KB`);
}
console.log(`\nicons generated from ${source}`);

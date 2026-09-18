/**
 * Build a single self-contained HTML file that runs by double-clicking it.
 *
 * `dist/` stays the canonical GitHub Pages artifact (absolute /<repo>/ asset
 * paths, separate .js/.css). This script additionally inlines every asset into
 * one .html file, so the app also works from `file://` with no server at all —
 * Chrome refuses to load external ES modules from file://, which is exactly why
 * double-clicking dist/index.html shows a blank page.
 *
 * Usage: npm run build:standalone   →  dist-standalone/nexq-web.html
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const dist = path.join(root, "dist");
const outDir = path.join(root, "dist-standalone");
const outFile = path.join(outDir, "nexq-web.html");

if (!existsSync(path.join(dist, "index.html"))) {
  console.error("dist/index.html not found — run `npm run build` first.");
  process.exit(1);
}

/** Resolve an asset href from index.html to a file inside dist/. */
function resolveAsset(href) {
  const clean = href
    .replace(/^https?:\/\/[^/]+/, "")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .replace(/^nexq-web\//, "");
  return path.join(dist, clean);
}

let html = await readFile(path.join(dist, "index.html"), "utf8");

// NOTE: every replacement below passes the payload through a replacer FUNCTION.
// A plain string replacement would interpret `$&`, `$'` and `` $` `` inside the
// minified bundle and splice fragments of the HTML into the JavaScript.

// 1. Inline stylesheets.
const cssHrefs = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*href="([^"]+)"[^>]*>/g)];
for (const [tag, href] of cssHrefs) {
  const css = await readFile(resolveAsset(href), "utf8");
  html = html.replace(tag, () => `<style>\n${css}\n</style>`);
}

// 2. Inline the module bundle (the only external script Vite emits).
const scriptTags = [...html.matchAll(/<script[^>]*src="([^"]+)"[^>]*><\/script>/g)];
if (scriptTags.length === 0) {
  console.error("No script tag found in dist/index.html — unexpected build output.");
  process.exit(1);
}
for (const [tag, src] of scriptTags) {
  const js = await readFile(resolveAsset(src), "utf8");
  // Never let the payload terminate the surrounding <script> element.
  const safeJs = js.replace(/<\/script/gi, "<\\/script");
  html = html.replace(tag, () => `<script type="module">\n${safeJs}\n</script>`);
}

// 3. Inline the favicon so the file is fully self-contained.
const iconTag = html.match(/<link[^>]+rel="icon"[^>]*>/)?.[0];
if (iconTag) {
  const iconHref = iconTag.match(/href="([^"]+)"/)?.[1];
  const iconPath = iconHref ? resolveAsset(iconHref) : null;
  if (iconPath && existsSync(iconPath)) {
    const ext = path.extname(iconPath).slice(1);
    const mime = ext === "svg" ? "image/svg+xml" : `image/${ext}`;
    const data = await readFile(iconPath);
    html = html.replace(
      iconTag,
      () => `<link rel="icon" type="${mime}" href="data:${mime};base64,${data.toString("base64")}" />`
    );
  }
}

// 4. Note the offline-first nature of this artifact.
html = html.replace("</title>", () => "</title>\n    <!-- standalone single-file build: open this file directly, no server needed -->");

// 5. Guard rails: the result must be fully self-contained and syntactically whole.
const leftovers = [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]*)"/g)].map((m) => m[1]);
if (leftovers.length > 0) {
  console.error(`Inlining incomplete — still referencing external assets: ${leftovers.join(", ")}`);
  process.exit(1);
}
if (!html.trimEnd().endsWith("</html>")) {
  console.error("Inlined document is truncated — refusing to write a broken file.");
  process.exit(1);
}

await mkdir(outDir, { recursive: true });
await writeFile(outFile, html, "utf8");

const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
console.log(`standalone build written: ${outFile} (${kb} KB, fully self-contained)`);
console.log("double-click it, or run: start \"\" \"" + outFile + "\"");

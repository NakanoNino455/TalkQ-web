/**
 * Live-translation verification.
 *
 * Runs the real dist/ bundle in Chrome with:
 *  - a fake microphone (Chrome flags + granted permission),
 *  - a deterministic fake Web Speech recognizer injected before app boot,
 *  - https://api.deepseek.com pointed at a local TLS mock that answers
 *    translation requests with streamed chunks.
 *
 * This exercises: mic permission → recognition (interim/final, auto-restart)
 * → queued streaming translation → bilingual subtitle list → export/clear/stop.
 */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
/* Optional dev-only tooling — install with:
 *   npm i -D playwright-core selfsigned
 * The app itself never depends on these.
 */
let selfsigned;
let chromium;
try {
  ({ default: selfsigned } = await import("selfsigned"));
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error("This optional harness needs its dev-only tools:\n  npm i -D playwright-core selfsigned");
  process.exit(2);
}
const PROJECT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(PROJECT, "dist");
const BASE = "/TalkQ-web/";
const APP_PORT = 4321;
const MOCK_PORT = 8445;
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

const results = [];
let currentGroup = "";
function group(name) {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}
function check(name, ok, extra = "") {
  results.push({ group: currentGroup, name, ok: Boolean(ok), extra });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
}

/* ── static server ───────────────────────────────────────────────────── */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};
const staticServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname === "/") {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  if (!url.pathname.startsWith(BASE)) {
    res.writeHead(404);
    return res.end("nope");
  }
  const rel = url.pathname.slice(BASE.length) || "index.html";
  const file = path.join(DIST, rel);
  if (!existsSync(file)) {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(await readFile(path.join(DIST, "index.html")));
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(await readFile(file));
});

/* ── Test documents: a real .docx (stored ZIP) and a real minimal PDF ── */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

/** Build a .docx-ish ZIP with stored (uncompressed) entries. */
function buildZip(entries) {
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 10); // stored
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, name);

    offset += local.length + name.length + data.length;
  }

  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, centralBuf, eocd]);
}

const DOCX_TEXT_1 = "TALKQ DOCX LINE ONE";
const DOCX_TEXT_2 = "TALKQ DOCX LINE TWO";
const docxBuffer = buildZip([
  {
    name: "[Content_Types].xml",
    data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
  },
  {
    name: "word/document.xml",
    data:
      '<?xml version="1.0" encoding="UTF-8"?>' +
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
      `<w:p><w:r><w:t>${DOCX_TEXT_1}</w:t></w:r></w:p>` +
      `<w:p><w:r><w:t>${DOCX_TEXT_2}</w:t></w:r><w:r><w:t> + EXTRA RUN</w:t></w:r></w:p>` +
      "</w:body></w:document>",
  },
]);

const TXT_TEXT = "TALKQ TXT 这是一份纯文本测试文档。";
const txtBuffer = Buffer.from(`第一行 ${TXT_TEXT}\n第二行：中文编码检查\n`, "utf8");

/** Minimal single-page PDF with a standard font, built with correct offsets. */
function buildPdf(text) {
  const content = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xrefStart = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objects.length; i += 1) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

const PDF_TEXT = "TALKQ PDF SECRET 42";
const pdfBuffer = buildPdf(PDF_TEXT);

/**
 * Upload through the real button (so the file-chooser path is exercised) and
 * wait for the chip. PDFs cold-start pdf.js + a 1.2 MB worker, so a fixed sleep
 * is not enough.
 */
async function uploadDocument(page, file, expectedChip) {
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10000 }),
    page.getByRole("button", { name: "上传文档" }).click(),
  ]);
  await chooser.setFiles([file]);
  if (expectedChip) {
    await page.getByText(expectedChip).first().waitFor({ timeout: 25000 }).catch(() => {});
  } else {
    await page.waitForTimeout(1500);
  }
}

/* ── DeepSeek mock with translation support ──────────────────────────── */
const state = { scenario: "ok", requests: [], translations: 0 };

const TRANSLATIONS = {
  "你好，这是": "Hello, this is",
  "你好，这是一次实时翻译测试": "Hello, this is a live translation test",
  "你好，这是一次实时翻译测试。": "Hello, this is a live translation test.",
  "第二句：今天天气": "Second sentence: the weather",
  "第二句：今天天气不错。": "Second sentence: the weather is nice today.",
  "English sentence": "这是一句英文",
  "English sentence for auto detection.": "这是一句用于自动检测方向的英文。",
};

function translateOf(text) {
  return TRANSLATIONS[text] ?? `[translated] ${text}`;
}

const handler = async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  let body = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = null;
  }
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end();
  }

  const system = body?.messages?.[0]?.content ?? "";
  const isTranslation = /simultaneous interpretation/i.test(String(system));
  const lastUser = [...(body?.messages ?? [])].reverse().find((m) => m.role === "user");
  const systemMessages = (body?.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => String(m.content));
  state.requests.push({
    isTranslation,
    isAsk: !isTranslation,
    thinking: body?.thinking ?? null,
    stream: body?.stream ?? null,
    model: body?.model,
    systems: systemMessages,
    system: String(system).slice(-120),
    text: typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content),
    contextPairs: isTranslation ? Math.max(0, (body.messages.length - 2) / 2) : 0,
  });

  if (state.scenario === "402") {
    res.writeHead(402, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "Insufficient Balance", code: "insufficient_balance" } }));
  }

  if (!body?.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
      })
    );
  }

  state.translations += 1;
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant" } }] }));

  const request = state.requests.at(-1);
  const answer = request.isTranslation
    ? translateOf(request.text ?? "")
    : `这是针对「${(request.text ?? "").slice(0, 12)}」的回答。`;
  const parts = answer.match(/.{1,18}/g) ?? [answer];
  for (const part of parts) {
    res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { content: part } }] }));
    await sleep(90);
  }
  res.write(
    chunk({
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    })
  );
  res.write("data: [DONE]\n\n");
  res.end();
};

const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});
const mockServer = createServer({ key: pems.private, cert: pems.cert }, handler);
await new Promise((r) => staticServer.listen(APP_PORT, "127.0.0.1", r));
await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));

const APP_URL = `http://127.0.0.1:${APP_PORT}${BASE}`;
console.log(`app:  ${APP_URL}`);
console.log(`mock: https://api.deepseek.com -> 127.0.0.1:${MOCK_PORT}`);

/* ── Fake recognizer + fake mic ──────────────────────────────────────── */
/*
 * `delay` is relative to the instance that plays the step; an `end` step
 * finishes that instance (Chrome does this on its own after a pause) and the
 * NEXT instance continues from the cursor, exactly like a real session.
 */
const FAKE_SCRIPT = [
  { delay: 300, type: "interim", text: "你好，这是" },
  { delay: 500, type: "interim", text: "你好，这是一次实时翻译测试" },
  { delay: 2400, type: "final", text: "你好，这是一次实时翻译测试。" },
  { delay: 400, type: "end" },
  { delay: 400, type: "interim", text: "第二句：今天天气" },
  { delay: 800, type: "final", text: "第二句：今天天气不错。" },
  { delay: 600, type: "interim", text: "English sentence" },
  { delay: 800, type: "final", text: "English sentence for auto detection." },
];

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    "--autoplay-policy=no-user-gesture-required",
  ],
});

async function newContext(grantMic) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  if (grantMic) await context.grantPermissions(["microphone"], { origin: APP_URL });

  await context.addInitScript(() => {
    // Seed once per browser session: a reload must NOT wipe what the app saved.
    if (!sessionStorage.getItem("nexq-e2e-seeded")) {
      localStorage.setItem("talkq_deepseek_api_key", "sk-translate-e2e-1234567890");
      localStorage.setItem(
        "talkq_settings",
        JSON.stringify({ lastView: "translate", livePreview: true, translateQuickMode: true })
      );
      localStorage.removeItem("talkq_translate_transcript");
      sessionStorage.setItem("nexq-e2e-seeded", "1");
    }

    // Deterministic stand-in for Chrome's SpeechRecognition.
    window.__NEXQ_RECOGNIZER_COUNT__ = window.__NEXQ_RECOGNIZER_COUNT__ ?? 0;
    window.__NEXQ_CURSOR__ = window.__NEXQ_CURSOR__ ?? 0;
    const emitted = window.__NEXQ_EMITTED__ ?? (window.__NEXQ_EMITTED__ = []);

    class FakeSpeechRecognition {
      constructor() {
        this.lang = "zh-CN";
        this.continuous = true;
        this.interimResults = true;
        this.maxAlternatives = 1;
        this.onstart = null;
        this.onend = null;
        this.onresult = null;
        this.onerror = null;
        this.onspeechstart = null;
        this.onspeechend = null;
        this._timers = [];
        window.__NEXQ_RECOGNIZER_COUNT__ += 1;
      }
      _emit(text, isFinal) {
        emitted.push({ text, isFinal });
        const result = [{ transcript: text, confidence: 0.92 }];
        result.isFinal = isFinal;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
      start() {
        this.onstart?.();
        const script = window.__NEXQ_SPEECH_SCRIPT__ ?? [];
        let elapsed = 0;
        // Continue from wherever the previous instance stopped (no replay).
        let i = window.__NEXQ_CURSOR__;
        for (; i < script.length; i += 1) {
          const step = script[i];
          elapsed += step.delay ?? 500;
          if (step.type === "end") {
            window.__NEXQ_CURSOR__ = i + 1;
            this._timers.push(setTimeout(() => this.onend?.(), elapsed));
            return;
          }
          this._timers.push(
            setTimeout(() => {
              if (step.type === "interim") this._emit(step.text, false);
              else if (step.type === "final") {
                this.onspeechstart?.();
                this._emit(step.text, true);
              } else if (step.type === "error") {
                this.onerror?.({ error: step.error });
              }
            }, elapsed)
          );
        }
        window.__NEXQ_CURSOR__ = i;
      }
      stop() {
        this._timers.forEach(clearTimeout);
        this._timers = [];
        this.onend?.();
      }
      abort() {
        this.stop();
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
  });
  // The script is injected per-context (serialisable argument).
  await context.addInitScript((script) => {
    window.__NEXQ_SPEECH_SCRIPT__ = script;
  }, FAKE_SCRIPT);

  return context;
}

try {
  const context = await newContext(true);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 180)));
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 180)}`));

  /* ── T1: translate surface boots ───────────────────────────────────── */
  group("T1 · live-translation surface");
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  check("opened directly on 实时翻译", await page.getByText("实时翻译").first().isVisible());
  check("empty-state explains the 3 steps", await page.getByText("允许麦克风").first().isVisible());
  check("start button present", await page.getByRole("button", { name: /开始实时翻译/ }).first().isVisible());
  check("direction switch present", await page.getByText("自动互译").first().isVisible());
  check("privacy note shown", await page.getByText("Google 的语音服务").first().isVisible());
  await page.screenshot({ path: path.join(ARTIFACTS, "t01-translate-idle.png") });

  /* ── T2: start → mic → recognition ────────────────────────────────── */
  group("T2 · start asks for the microphone and starts recognition");
  await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await page.getByText("正在聆听").first().waitFor({ timeout: 10000 }).catch(() => {});
  check("status becomes 正在聆听", await page.getByText("正在聆听").first().isVisible());
  check("stop button offered", await page.getByRole("button", { name: /停止翻译/ }).first().isVisible());
  check("mic meter rendered", (await page.locator("canvas, .flex.h-6").count()) > 0);
  const recognizerReady = await page
    .waitForFunction(() => (window.__NEXQ_RECOGNIZER_COUNT__ ?? 0) >= 1, undefined, { timeout: 5000 })
    .then(() => true)
    .catch(() => false);
  check(
    "recognizer instance created",
    recognizerReady,
    `count=${await page.evaluate(() => window.__NEXQ_RECOGNIZER_COUNT__ ?? "undefined")}`
  );

  /* ── T3: interim text + preview translation ───────────────────────── */
  group("T3 · interim speech shows live, with preview translation");
  await page.getByText("正在识别…").first().waitFor({ timeout: 8000 });
  check("interim line visible", await page.getByText("正在识别…").first().isVisible());
  await page.getByText("你好，这是一次实时翻译测试").first().waitFor({ timeout: 8000 }).catch(() => {});
  const interimText = await page
    .getByText("你好，这是一次实时翻译测试")
    .first()
    .isVisible()
    .catch(() => false);
  check("interim transcript rendered", interimText);

  // The interim is stable for ~2.4s, so the debounced preview must land.
  const previewOk = await page
    .getByText("Hello, this is a live translation test", { exact: false })
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("preview translation streamed in before the final", previewOk);
  check("preview labelled as 预览", await page.getByText("预览", { exact: false }).first().isVisible().catch(() => false));
  await page.screenshot({ path: path.join(ARTIFACTS, "t02-interim-preview.png") });

  /* ── T4: final utterance → subtitle segment ───────────────────────── */
  group("T4 · finished utterance becomes a bilingual subtitle");
  await page.getByText("你好，这是一次实时翻译测试。").first().waitFor({ timeout: 12000 });
  check("source sentence kept", await page.getByText("你好，这是一次实时翻译测试。").first().isVisible());
  const caretSeen = await page
    .locator(".stream-caret")
    .first()
    .waitFor({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("translation streams (caret visible while streaming)", caretSeen);
  await page.getByText("Hello, this is a live translation test.").first().waitFor({ timeout: 15000 });
  check("translation completed", await page.getByText("Hello, this is a live translation test.").first().isVisible());
  check(
    "auto direction detected zh → EN",
    await page.getByText("中文 → EN").first().isVisible().catch(() => false)
  );
  check(
    "translation request used deepseek-flash + no thinking",
    state.requests.some((r) => r.isTranslation && r.model === "deepseek-flash" && r.thinking?.type === "disabled")
  );
  check("translation prompt is the interpreter prompt", state.requests.some((r) => r.isTranslation));

  /* ── T5: Chrome auto-end → recognizer restarts ────────────────────── */
  group("T5 · session survives Chrome ending recognition");
  await page.waitForFunction(() => window.__NEXQ_RECOGNIZER_COUNT__ >= 2, undefined, { timeout: 12000 }).catch(() => {});
  const instances = await page.evaluate(() => window.__NEXQ_RECOGNIZER_COUNT__);
  check("recognizer auto-restarted", instances >= 2, `${instances} instances`);
  check("still listening after restart", await page.getByText("正在聆听").first().isVisible());

  /* ── T6: second + third utterances, context, auto EN→ZH ───────────── */
  group("T6 · continues with context and flips direction automatically");
  await page.getByText("天气不错").first().waitFor({ timeout: 15000 });
  await page.getByText("这是一句用于自动检测方向的英文。").first().waitFor({ timeout: 15000 });
  check("second subtitle translated", await page.getByText("Second sentence: the weather is nice today.").first().isVisible());
  check("English input translated into Chinese", await page.getByText("这是一句用于自动检测方向的英文。").first().isVisible());
  check(
    "auto direction flipped to EN → 中文",
    await page.getByText("EN → 中文").first().isVisible().catch(() => false)
  );
  const withContext = state.requests.filter((r) => r.isTranslation && r.contextPairs > 0).length;
  check("earlier pairs sent as context", withContext > 0, `${withContext} requests with context`);
  await page.screenshot({ path: path.join(ARTIFACTS, "t03-subtitles.png") });

  /* ── T7: per-segment actions ──────────────────────────────────────── */
  group("T7 · subtitle actions");
  const segmentCounter = await page
    .getByText(/^\d+ 句$/)
    .first()
    .innerText()
    .catch(() => "none");
  check("segment counter matches the 3 utterances", segmentCounter === "3 句", segmentCounter);
  const before = state.translations;
  await page.locator('button[aria-label="重新翻译"]').first().click();
  await page.waitForFunction(
    (n) => document.body.innerText.includes("Hello, this is a live translation test.") && n > 0,
    before,
    { timeout: 8000 }
  ).catch(() => {});
  await page.waitForTimeout(1200);
  check("retranslate issued another request", state.translations > before, `${before} → ${state.translations}`);

  /* ── T8: copy / export / clear ────────────────────────────────────── */
  group("T8 · copy all, export and clear");
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: APP_URL });
  await page.getByRole("button", { name: /复制全部/ }).click();
  await page.waitForTimeout(400);
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("copy-all produced a transcript", clip.includes("实时翻译记录") && clip.includes("天气不错"), clip.slice(0, 40).replace(/\n/g, " "));

  const download = await Promise.all([
    page.waitForEvent("download", { timeout: 8000 }).catch(() => null),
    page.getByRole("button", { name: /导出/ }).click(),
  ]).then(([d]) => d);
  check("export triggers a .txt download", Boolean(download?.suggestedFilename().endsWith(".txt")), download?.suggestedFilename() ?? "none");

  /* ── T9: stop releases the microphone ─────────────────────────────── */
  group("T9 · stop / mode switch releases the microphone");
  await page.getByRole("button", { name: /停止翻译/ }).first().click();
  await page.waitForTimeout(300);
  check("status back to 未开始", await page.getByText("未开始").first().isVisible());
  const micReleased = await page.evaluate(async () => {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.some((d) => d.kind === "audioinput");
  });
  check("audio input still enumerable (mic closed cleanly)", micReleased);

  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("天气不错").first().waitFor({ timeout: 10000 });
  check("transcript persisted across reload", await page.getByText("Second sentence: the weather is nice today.").first().isVisible());

  // The confirm() dialog must be handled BEFORE the click, otherwise Playwright
  // auto-dismisses it and clear() never runs.
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: /清空/ }).first().click();
  await page.waitForTimeout(600);
  check("clear empties the transcript", (await page.getByText("天气不错").count()) === 0);

  /* ── T10: translation errors are surfaced per segment ─────────────── */
  group("T10 · DeepSeek errors surface on the segment");
  state.scenario = "402";
  await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await page.getByText("Insufficient DeepSeek Balance").first().waitFor({ timeout: 20000 }).catch(() => {});
  check(
    "402 shows 'Insufficient DeepSeek Balance'",
    await page.getByText("Insufficient DeepSeek Balance").first().isVisible().catch(() => false)
  );
  state.scenario = "ok";
  await page.getByRole("button", { name: /停止翻译/ }).first().click().catch(() => {});
  await page.screenshot({ path: path.join(ARTIFACTS, "t04-error.png") });

  // A 402 response legitimately logs a "Failed to load resource" console entry.
  /* ── T13: document upload (PDF / TXT / DOCX) ──────────────────────── */
  const askPanel = page.locator('aside[aria-label="问答"]');
  group("T13 · 问答栏可上传 PDF / TXT / DOCX");
  check("upload button present", await page.getByRole("button", { name: "上传文档" }).isVisible());

  const asksBeforeDocs = state.requests.filter((r) => r.isAsk).length;
  const docSystemBlock = (request) =>
    (request.systems ?? []).find((s) => s.includes("【用户上传的文档】")) ?? "";

  // TXT
  await uploadDocument(page, {
    name: "notes.txt",
    mimeType: "text/plain",
    buffer: txtBuffer,
  }, "notes.txt");
  check("TXT chip appears with name", await askPanel.getByText("notes.txt").first().isVisible());
  check("TXT chip shows the size badge", await askPanel.getByText("txt", { exact: true }).first().isVisible());

  await askPanel.locator("textarea").first().fill("这份 txt 讲了什么？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(2500);
  const txtRequest = state.requests.filter((r) => r.isAsk).at(-1);
  check("TXT content was sent to the model", docSystemBlock(txtRequest).includes(TXT_TEXT), docSystemBlock(txtRequest).slice(0, 60));
  check("TXT filename is in the context block", docSystemBlock(txtRequest).includes("notes.txt"));

  // DOCX
  await uploadDocument(page, {
    name: "report.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer: docxBuffer,
  }, "report.docx");
  check("DOCX chip appears", await askPanel.getByText("report.docx").first().isVisible());

  await askPanel.locator("textarea").first().fill("docx 里写了什么？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(2500);
  const docxRequest = state.requests.filter((r) => r.isAsk).at(-1);
  const docxBlock = docSystemBlock(docxRequest);
  check(
    "DOCX text extracted (ZIP + document.xml)",
    docxBlock.includes(DOCX_TEXT_1) && docxBlock.includes(DOCX_TEXT_2),
    docxBlock.replace(/\s+/g, " ").slice(0, 70)
  );
  check(
    "DOCX runs in the same paragraph are joined",
    docxBlock.includes(`${DOCX_TEXT_2} + EXTRA RUN`)
  );
  check("both documents ride along now", docxBlock.includes("notes.txt") && docxBlock.includes("report.docx"));

  // PDF (lazy-loads pdf.js + its worker)
  await uploadDocument(page, {
    name: "secret.pdf",
    mimeType: "application/pdf",
    buffer: pdfBuffer,
  });
  check("PDF chip appears (pdf.js loaded on demand)", await askPanel.getByText("secret.pdf").first().isVisible());
  // (page count is asserted below, on the extracted context)

  await askPanel.locator("textarea").first().fill("pdf 里的暗号是什么？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(3000);
  const pdfRequest = state.requests.filter((r) => r.isAsk).at(-1);
  check(
    "PDF text was extracted by pdf.js",
    docSystemBlock(pdfRequest).includes(PDF_TEXT),
    docSystemBlock(pdfRequest).replace(/\s+/g, " ").slice(-70)
  );
  check("PDF page count reported in the context", docSystemBlock(pdfRequest).includes("1 页"));

  check(
    "document text stays out of the visible conversation",
    !(await askPanel.locator(".nexq-prose").first().innerText()).includes("【用户上传的文档】")
  );
  check(
    "sent messages show which files were attached",
    (await askPanel.getByText("secret.pdf").count()) >= 2
  );

  // Persistence + removal
  await page.reload({ waitUntil: "networkidle" });
  await askPanel.getByText("secret.pdf").first().waitFor({ timeout: 10000 }).catch(() => {});
  check("attachments survive a reload", await askPanel.getByText("secret.pdf").first().isVisible());

  await askPanel.getByRole("button", { name: "移除 secret.pdf" }).click();
  const removalSettled = await askPanel
    .getByRole("button", { name: "移除 secret.pdf" })
    .waitFor({ state: "detached", timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check(
    "removing a document clears its chip",
    removalSettled,
    `chips left: ${await askPanel.getByRole("button", { name: /^移除/ }).count()}`
  );

  const asksBeforeRemoval = state.requests.filter((r) => r.isAsk).length;
  await askPanel.locator("textarea").first().fill("现在还有文档吗？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(2500);
  const afterRemoval = state.requests.filter((r) => r.isAsk);
  check(
    "removed document is no longer sent",
    afterRemoval.length > asksBeforeRemoval && !docSystemBlock(afterRemoval.at(-1)).includes(PDF_TEXT)
  );
  check(
    "the remaining documents are still sent",
    docSystemBlock(afterRemoval.at(-1)).includes("notes.txt")
  );

  // Unsupported file gets a specific error.
  await uploadDocument(page, {
    name: "legacy.doc",
    mimeType: "application/msword",
    buffer: Buffer.from("not really a doc"),
  }, null);
  check(
    "unsupported extension is rejected with a reason",
    (await page
      .getByText("不认识的扩展名", { exact: false })
      .first()
      .isVisible()
      .catch(() => false)) ||
      (await page
        .getByText("Unsupported document", { exact: false })
        .first()
        .isVisible()
        .catch(() => false))
  );
  await page.screenshot({ path: path.join(ARTIFACTS, "t08-documents.png") });

  const noisy = consoleErrors.filter(
    (e) => !/favicon|Failed to load resource|net::ERR/i.test(e)
  );
  check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));

  /* ── T11: Q&A panel embedded in the translate surface ─────────────── */
  group("T12 · 问答栏嵌在实时翻译里，可带字幕上下文提问");
  const panel = page.locator('aside[aria-label="问答"]');
  check("ask panel is part of the translate surface", (await panel.count()) === 1);
  check(
    "context toggle present",
    await panel.getByText("附带最近字幕作为上下文").first().isVisible()
  );
  check(
    "context toggle reports how many subtitles ride along",
    await panel.getByText(/已带上最近 \d+ 句/).first().isVisible().catch(() => false)
  );
  check("no mode switch left in the sidebar", (await page.getByText("对话", { exact: true }).count()) === 0);

  // T10 stopped the session; start it again so the remaining utterances arrive.
  await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await page
    .waitForFunction(
      () => document.querySelectorAll('[class*="group/seg"]').length >= 3,
      undefined,
      { timeout: 25000 }
    )
    .catch(() => {});
  await page.getByText("English sentence for auto detection.").first().waitFor({ timeout: 25000 });

  // Copy buttons are named by content: English first, then the translation.
  const copyLabels = await page
    .locator('button[aria-label^="复制"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
  const englishCount = copyLabels.filter((l) => l === "复制英文").length;
  const translationCount = copyLabels.filter((l) => l === "复制译文").length;
  check(
    "first copy button is 复制英文 (per segment)",
    englishCount >= 2,
    `${englishCount}× 复制英文 of ${copyLabels.length} copy buttons`
  );
  check("second copy button is 复制译文 (per segment)", translationCount >= 2);
  const ordered = copyLabels.every(
    (label, i) => label !== "复制译文" || ["复制英文", "复制原文"].includes(copyLabels[i - 1])
  );
  check("within a subtitle: English button comes before 复制译文", ordered, JSON.stringify(copyLabels));
  check(
    "no copy button still says 复制原文 for English subtitles",
    copyLabels.slice(-2).join(",") === "复制英文,复制译文",
    JSON.stringify(copyLabels.slice(-2))
  );

  const shareButtons = page.locator('button[aria-label="分享到问答（自动发送英文）"]');
  check(
    "share button replaced the question mark",
    (await shareButtons.count()) >= 3 &&
      (await page.locator('button[aria-label="就这句提问"]').count()) === 0,
    `${await shareButtons.count()} share buttons`
  );

  // Share → the English half lands in the Q&A box and is sent immediately.
  const asksBefore = state.requests.filter((r) => r.isAsk).length;
  await page
    .locator('[class*="group/seg"]')
    .filter({ hasText: "English sentence for auto detection." })
    .getByRole("button", { name: "分享到问答（自动发送英文）" })
    .click();
  await page.getByText("这是针对", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  const askRequests = state.requests.filter((r) => r.isAsk);
  check("share auto-sent a question", askRequests.length === asksBefore + 1, `${asksBefore} → ${askRequests.length}`);
  check(
    "share sent ONLY the English text",
    askRequests.at(-1)?.text === "English sentence for auto detection.",
    JSON.stringify(askRequests.at(-1)?.text ?? null)
  );
  check(
    "shared message appears in the Q&A thread",
    await panel.getByText("English sentence for auto detection.", { exact: true }).first().isVisible()
  );
  const withTranscript = askRequests.find((r) =>
    r.systems?.some(
      (s) => s.includes("【实时翻译字幕上下文】") && /\n\d+\. \S/.test(s) // numbered subtitle lines
    )
  );
  check(
    "question carried the recent subtitles as context",
    Boolean(withTranscript),
    withTranscript
      ? `context block with ${(withTranscript.systems.find((s) => s.includes("【实时翻译"))?.match(/\n\d+\. /g) ?? []).length} subtitle line(s)`
      : `systems=${JSON.stringify((askRequests[0]?.systems ?? []).map((s) => s.slice(0, 30)))}`
  );
  check(
    "visible history stays clean (context is transient)",
    !(await panel.locator(".nexq-prose").first().innerText()).includes("实时翻译字幕上下文")
  );
  check("answer rendered in the panel", (await panel.locator(".nexq-prose").count()) >= 1);
  await page.screenshot({ path: path.join(ARTIFACTS, "t06-ask-panel.png") });

  /* ── T11: permission denied path ──────────────────────────────────── */
  group("T11 · denied microphone is explained, not silent");
  await context.close();
  // A browser WITHOUT --use-fake-ui-for-media-stream denies getUserMedia when
  // no permission was granted — exactly the real "user clicked Block" case.
  const denyingBrowser = await chromium.launch({
    channel: "chrome",
    headless: true,
    args: [
      `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT}`,
      "--use-fake-device-for-media-stream",
    ],
  });
  const denied = await denyingBrowser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1280, height: 800 },
  });
  await denied.addInitScript(() => {
    localStorage.setItem("talkq_deepseek_api_key", "sk-translate-e2e-1234567890");
    localStorage.setItem("talkq_settings", JSON.stringify({ lastView: "translate" }));
  });
  const deniedPage = await denied.newPage();
  await deniedPage.goto(APP_URL, { waitUntil: "networkidle" });
  await deniedPage.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await deniedPage.waitForTimeout(2500);
  const deniedText = await deniedPage.locator("body").innerText();
  check(
    "microphone denial explained",
    /麦克风权限被拒绝|麦克风不可用|Microphone permission denied|Microphone unavailable/i.test(deniedText),
    deniedText.match(/Microphone[^\n]*/)?.[0] ?? "no message"
  );
  await deniedPage.screenshot({ path: path.join(ARTIFACTS, "t05-mic-denied.png") });
  await denied.close();
  await denyingBrowser.close();
} catch (err) {
  check(`harness crashed: ${err.message}`, false);
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(64)}`);
console.log(`checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
}
console.log(`mock: ${state.translations} streaming translations, ${state.requests.length} requests`);
process.exit(failed.length ? 1 : 0);

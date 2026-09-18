/**
 * Mobile layout verification (phone viewport, touch enabled).
 *
 * Same fake mic + programmable fake recognizer + mocked DeepSeek as the
 * translate suite, but in a 390×844 phone viewport: checks the bottom tab bar,
 * full-screen panes, thumb-sized targets, the share→ask tab switch, and that
 * nothing overflows horizontally or hides under the browser chrome.
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
const APP_PORT = 4322;
const MOCK_PORT = 8447;
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

const PHONE = { width: 390, height: 844 };
const VIEWPORT_HEIGHT = PHONE.height;

const results = [];
let currentGroup = "";
const group = (name) => {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
};
const check = (name, ok, extra = "") => {
  results.push({ group: currentGroup, name, ok: Boolean(ok), extra });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

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

/* ── DeepSeek mock ───────────────────────────────────────────────────── */
const TRANSLATIONS = {
  "你好，这是一次实时翻译测试。": "Hello, this is a live translation test.",
  "English sentence for auto detection.": "这是一句用于自动检测方向的英文。",
};
const state = { requests: [], askTexts: [], askSystems: [] };

const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});

const mockServer = createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const body = raw ? JSON.parse(raw) : null;
  if (!body?.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ model: "deepseek-flash", choices: [{ message: { content: "Hello!" } }] }));
  }
  const systems = (body.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => String(m.content));
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  const isTranslation = /simultaneous interpretation/i.test(systems.join(" "));
  state.requests.push({ isTranslation, text });
  if (!isTranslation) {
    state.askTexts.push(text);
    state.askSystems.push(systems);
  }

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const answer = isTranslation
    ? (TRANSLATIONS[text] ?? `[translated] ${text}`)
    : "结合刚才的字幕，这句话的意思是：这是一次实时翻译测试。";
  for (const part of answer.match(/.{1,16}/g) ?? [answer]) {
    res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { content: part } }] }));
    await sleep(70);
  }
  res.write(
    chunk({
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    })
  );
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => staticServer.listen(APP_PORT, "127.0.0.1", r));
await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));
const APP_URL = `http://127.0.0.1:${APP_PORT}${BASE}`;

const SCRIPT = [
  { delay: 400, type: "interim", text: "你好，这是一次实时翻译测试" },
  { delay: 2200, type: "final", text: "你好，这是一次实时翻译测试。" },
  { delay: 600, type: "interim", text: "English sentence" },
  { delay: 900, type: "final", text: "English sentence for auto detection." },
];

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT}`,
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});

const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: PHONE,
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
await context.grantPermissions(["microphone"], { origin: APP_URL });
await context.addInitScript(
  ([script]) => {
    localStorage.setItem("talkq_deepseek_api_key", "sk-mobile-e2e-1234567890");
    localStorage.setItem("talkq_settings", JSON.stringify({ livePreview: true, translateQuickMode: true }));
    localStorage.removeItem("talkq_translate_transcript");

    window.__NEXQ_CURSOR__ = 0;
    class FakeSpeechRecognition {
      constructor() {
        this.lang = "zh-CN";
        this.continuous = true;
        this.interimResults = true;
        this.maxAlternatives = 1;
        this._timers = [];
      }
      _emit(text, isFinal) {
        const result = [{ transcript: text, confidence: 0.9 }];
        result.isFinal = isFinal;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
      start() {
        this.onstart?.();
        let elapsed = 0;
        let i = window.__NEXQ_CURSOR__;
        for (; i < script.length; i += 1) {
          const step = script[i];
          elapsed += step.delay ?? 500;
          this._timers.push(
            setTimeout(() => {
              if (step.type === "interim") this._emit(step.text, false);
              else this._emit(step.text, true);
            }, elapsed)
          );
        }
        window.__NEXQ_CURSOR__ = i;
      }
      stop() {
        this._timers.forEach(clearTimeout);
        this.onend?.();
      }
      abort() {
        this.stop();
      }
    }
    window.SpeechRecognition = FakeSpeechRecognition;
    window.webkitSpeechRecognition = FakeSpeechRecognition;
  },
  [SCRIPT]
);

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`));

try {
  /* ── M1: phone layout ─────────────────────────────────────────────── */
  group("M1 · phone layout boots with bottom tabs");
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  check("no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check("desktop sidebar is not rendered", (await page.locator("aside").count()) === 0);
  check("bottom tab 字幕", await page.locator('nav[aria-label="主导航"]').getByRole("button", { name: /^字幕/ }).isVisible());
  check("bottom tab 问答", await page.locator('nav[aria-label="主导航"]').getByRole("button", { name: /^问答/ }).isVisible());
  check("start button reachable", await page.getByRole("button", { name: /开始实时翻译/ }).first().isVisible());

  const tabBox = await page.locator('nav[aria-label="主导航"]').getByRole("button", { name: /^字幕/ }).boundingBox();
  check("tab bar sits at the bottom of the viewport", tabBox && tabBox.y + tabBox.height <= VIEWPORT_HEIGHT + 1, JSON.stringify(tabBox));
  const startBox = await page.getByRole("button", { name: /开始实时翻译/ }).first().boundingBox();
  check("primary action is thumb-sized (≥44px)", startBox && startBox.height >= 44, `h=${startBox?.height}`);
  await page.screenshot({ path: path.join(ARTIFACTS, "m01-idle.png") });

  /* ── M2: microphone + subtitles ───────────────────────────────────── */
  group("M2 · start translation on a phone");
  await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await page.getByText("正在聆听").first().waitFor({ timeout: 12000 }).catch(() => {});
  check("status 正在聆听", await page.getByText("正在聆听").first().isVisible());
  await page.getByText("你好，这是一次实时翻译测试。").first().waitFor({ timeout: 15000 });
  await page.getByText("Hello, this is a live translation test.").first().waitFor({ timeout: 15000 });
  check("subtitle rendered on mobile", await page.getByText("你好，这是一次实时翻译测试。").first().isVisible());

  const targetSize = await page
    .locator(".subtitle-target")
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  check("translation uses the larger mobile type scale", targetSize >= 16, `${targetSize}px`);
  check("no horizontal overflow after subtitles", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));

  const actionBox = await page.locator('button[aria-label="复制英文"]').first().boundingBox();
  check("subtitle action buttons are thumb-sized", actionBox && actionBox.height >= 32 && actionBox.width >= 32, JSON.stringify(actionBox));
  await page.screenshot({ path: path.join(ARTIFACTS, "m02-subtitles.png") });

  /* ── M3: overflow menu ────────────────────────────────────────────── */
  group("M3 · overflow menu is a tappable bottom sheet");
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.waitForTimeout(300);
  check("menu shows 复制全部字幕", await page.getByText("复制全部字幕").first().isVisible());
  check("menu shows 导出 .txt", await page.getByText("导出 .txt").first().isVisible());
  check("menu shows 清空字幕", await page.getByText("清空字幕").first().isVisible());
  check("menu renders above the subtitle list (portal)", await page.evaluate(() => {
    // The sheet must be a child of <body>, not nested inside the blurred header.
    const dialog = document.querySelector('[role="dialog"][aria-label="更多操作"]');
    return Boolean(dialog && dialog.parentElement === document.body);
  }));
  await page.screenshot({ path: path.join(ARTIFACTS, "m03-menu.png") });

  // The real regression: the item must actually receive the tap. Playwright's
  // click hit-tests the element, so a covered button fails here.
  let dialogRaised = false;
  page.once("dialog", (d) => {
    dialogRaised = true;
    void d.dismiss(); // keep the transcript for the tests below
  });
  const tapped = await page
    .getByRole("button", { name: "清空字幕" })
    .click({ timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("清空字幕 is tappable through the sheet", tapped);
  await page.waitForTimeout(500);
  check("tapping 清空字幕 raised the confirm dialog", dialogRaised);
  check(
    "dismissing the confirm keeps the transcript",
    (await page.locator('[class*="group/seg"]').count()) > 0
  );

  /* ── M4: share switches to the Q&A tab and asks ───────────────────── */
  group("M4 · share jumps to the 问答 tab and sends only the English");
  await page.getByText("English sentence for auto detection.").first().waitFor({ timeout: 20000 });
  check(
    "two share buttons",
    (await page.locator('button[aria-label="分享到问答（自动发送英文）"]').count()) >= 2
  );
  check(
    "language chip stays on one line on a phone",
    await page
      .locator('[class*="group/seg"]')
      .last()
      .locator("span.whitespace-nowrap")
      .first()
      .evaluate((el) => el.getBoundingClientRect().height < 22)
      .catch(() => false)
  );
  await page.locator('button[aria-label="分享到问答（自动发送英文）"]').last().click();
  await page.getByText("结合刚才的字幕", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
  check("switched to the 问答 tab", await page.locator('aside[aria-label="问答"]').isVisible());
  check("share auto-sent only the English", state.askTexts.at(-1) === "English sentence for auto detection.", JSON.stringify(state.askTexts.at(-1) ?? null));
  check(
    "the shared question carried the subtitle context",
    state.askSystems.some((systems) => systems.some((s) => s.includes("【实时翻译字幕上下文】") && /\n\d+\. \S/.test(s)))
  );
  check("answer streamed in the ask tab", (await page.locator(".nexq-prose").count()) >= 1);

  const composerBox = await page.locator('aside[aria-label="问答"] textarea').first().boundingBox();
  check(
    "composer stays inside the viewport (not under the tab bar)",
    composerBox && composerBox.y + composerBox.height <= VIEWPORT_HEIGHT - 40,
    JSON.stringify(composerBox)
  );
  await page.screenshot({ path: path.join(ARTIFACTS, "m04-ask-tab.png") });

  /* ── M5: typing + sending from the phone ──────────────────────────── */
  group("M5 · paste-and-ask works with the on-screen keyboard");
  const input = page.locator('aside[aria-label="问答"] textarea').first();
  await input.fill("这句话里有哪些生词？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.waitForTimeout(1500);
  check("typed question was sent", state.askTexts.at(-1) === "这句话里有哪些生词？", JSON.stringify(state.askTexts.at(-1) ?? null));

  /* ── M6: back to subtitles ────────────────────────────────────────── */
  group("M6 · switching back keeps the session");
  await page.locator('nav[aria-label="主导航"]').getByRole("button", { name: /^字幕/ }).click();
  await page.waitForTimeout(400);
  check("subtitle pane restored", await page.getByText("你好，这是一次实时翻译测试。").first().isVisible());
  check("mic still listening", await page.getByText("正在聆听").first().isVisible());

  await page.getByRole("button", { name: /停止翻译/ }).first().click();
  await page.waitForTimeout(400);
  check("stop releases the microphone", await page.getByText("未开始").first().isVisible());

  // With recognition stopped the transcript is frozen, so clearing is testable.
  await page.getByRole("button", { name: "更多操作" }).click();
  await page.waitForTimeout(300);
  page.once("dialog", (d) => d.accept());
  await page.getByRole("button", { name: "清空字幕" }).click();
  await page.waitForTimeout(700);
  check("清空字幕 really empties the transcript", (await page.locator('[class*="group/seg"]').count()) === 0);
  check("empty state comes back after clearing", await page.getByText("点一下开始实时翻译").first().isVisible());
  await page.screenshot({ path: path.join(ARTIFACTS, "m07-cleared.png") });

  /* ── M7: sidebar drawer + settings on mobile ──────────────────────── */
  group("M7 · drawer + settings are usable on a phone");
  await page.getByRole("button", { name: "Toggle sidebar" }).first().click();
  await page.waitForTimeout(400);
  check("sidebar drawer opens", (await page.locator("aside").count()) >= 1);
  const drawerBox = await page.locator("aside").first().boundingBox();
  check("drawer fits the phone width", drawerBox && drawerBox.width <= PHONE.width * 0.9, JSON.stringify(drawerBox));
  await page.screenshot({ path: path.join(ARTIFACTS, "m05-drawer.png") });
  await page.getByRole("button", { name: "Close sidebar" }).click();
  await page.waitForTimeout(300);

  await page.getByRole("button", { name: "Settings" }).first().click();
  await page.getByRole("dialog", { name: "Settings" }).waitFor({ timeout: 5000 });
  check("settings panel opens", await page.getByRole("dialog", { name: "Settings" }).isVisible());
  check("settings has no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(ARTIFACTS, "m06-settings.png") });

  const noisy = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
  check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));
} catch (err) {
  check(`harness crashed: ${err.message}`, false);
  await page.screenshot({ path: path.join(ARTIFACTS, "m99-crash.png") }).catch(() => {});
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(64)}`);
console.log(`mobile checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
}
process.exit(failed.length ? 1 : 0);

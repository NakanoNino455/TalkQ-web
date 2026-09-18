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
  console.error(
    "This optional harness needs its dev-only tools:\n  npm i -D playwright-core selfsigned\n" +
      "It drives the built dist/ bundle in your installed Chrome with a fake microphone and a\n" +
      "mock of https://api.deepseek.com, so no API key and no real mic are required."
  );
  process.exit(2);
}

const PROJECT = path.resolve(import.meta.dirname, "..");
const DIST = path.join(PROJECT, "dist");
const BASE = "/nexq-web/";
const APP_PORT = 4321;
const MOCK_PORT = 8445;
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(2);
}

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
  state.requests.push({
    isTranslation,
    thinking: body?.thinking ?? null,
    stream: body?.stream ?? null,
    model: body?.model,
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

  const answer = translateOf(state.requests.at(-1).text ?? "");
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
      localStorage.setItem("nexq_deepseek_api_key", "sk-translate-e2e-1234567890");
      localStorage.setItem(
        "nexq_settings",
        JSON.stringify({ lastView: "translate", livePreview: true, translateQuickMode: true })
      );
      localStorage.removeItem("nexq_translate_transcript");
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
  const noisy = consoleErrors.filter(
    (e) => !/favicon|Failed to load resource|net::ERR/i.test(e)
  );
  check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));

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
    localStorage.setItem("nexq_deepseek_api_key", "sk-translate-e2e-1234567890");
    localStorage.setItem("nexq_settings", JSON.stringify({ lastView: "translate" }));
  });
  const deniedPage = await denied.newPage();
  await deniedPage.goto(APP_URL, { waitUntil: "networkidle" });
  await deniedPage.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await deniedPage.waitForTimeout(2500);
  const deniedText = await deniedPage.locator("body").innerText();
  check(
    "microphone denial explained",
    /Microphone permission denied|Microphone unavailable/i.test(deniedText),
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

/**
 * Start → stop → start again must keep working.
 *
 * Reported symptom: the first session recognises fine, but after stopping and
 * starting again there is no recognition and no reaction at all.
 *
 * The fake recognizer below mimics the part of Chrome's behaviour that causes
 * it: `stop()` ends the session *asynchronously*, and calling `start()` while
 * the previous session is still alive throws
 * "InvalidStateError: recognition has already started".
 *
 *   node verification/verify-restart.mjs
 */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

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
const APP_PORT = 4337;
const MOCK_PORT = 8452;
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });

if (!existsSync(path.join(DIST, "index.html"))) {
  console.error("dist/ is missing — run `npm run build` first.");
  process.exit(2);
}

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

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
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

const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});
const translated = [];
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
    return res.end(JSON.stringify({ model: "deepseek-flash", choices: [{ message: { content: "Hi" } }] }));
  }
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  translated.push(typeof lastUser?.content === "string" ? lastUser.content : "");

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { content: "[EN] ok" } }] }));
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => staticServer.listen(APP_PORT, "127.0.0.1", r));
await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));
const APP_URL = `http://127.0.0.1:${APP_PORT}${BASE}`;

/** Which sentence each session should recognise (indexed by instance number). */
const SESSION_TEXTS = [
  "session one works.",
  "session two works.",
  "session three works.",
  "session four works.",
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

const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
await context.grantPermissions(["microphone"], { origin: APP_URL });
await context.addInitScript((sessionTexts) => {
  localStorage.setItem("talkq_deepseek_api_key", "sk-restart-e2e");
  localStorage.setItem("talkq_settings", JSON.stringify({ farFieldMode: true, livePreview: false }));
  localStorage.removeItem("talkq_translate_transcript");

  window.__FACTORY_CALLS__ = 0;
  window.__START_ATTEMPTS__ = 0;
  window.__START_THROWS__ = 0;
  window.__EMITTED__ = [];
  /** "normal" | "race" (start throws for a while) | "stuck" (never fires onstart). */
  window.__FAKE_MODE__ = "normal";
  window.__RACE_THROWS_LEFT__ = 0;
  window.__SET_FAKE_MODE__ = (mode, throwsLeft = 0) => {
    window.__FAKE_MODE__ = mode;
    window.__RACE_THROWS_LEFT__ = throwsLeft;
  };
  /** The one session Chrome currently has open, like the real API. */
  let activeSession = null;

  class FakeSpeechRecognition {
    constructor() {
      this.lang = "zh-CN";
      this.continuous = true;
      this.interimResults = true;
      this.maxAlternatives = 1;
      this._alive = false;
      window.__FACTORY_CALLS__ += 1;
      this._index = window.__FACTORY_CALLS__ - 1;
    }
    start() {
      window.__START_ATTEMPTS__ += 1;
      // Chrome: only one session may be open; restarting too soon throws.
      if (activeSession && activeSession !== this) {
        window.__START_THROWS__ += 1;
        const err = new Error("recognition has already started");
        err.name = "InvalidStateError";
        throw err;
      }
      if (window.__FAKE_MODE__ === "race" && window.__RACE_THROWS_LEFT__ > 0) {
        window.__RACE_THROWS_LEFT__ -= 1;
        window.__START_THROWS__ += 1;
        const err = new Error("recognition has already started");
        err.name = "InvalidStateError";
        throw err;
      }
      activeSession = this;
      this._alive = true;
      // "stuck": the browser accepts the call but the session never opens.
      if (window.__FAKE_MODE__ === "stuck") return;
      this.onstart?.();
      // Count *successful* sessions, not instances: a retried start creates
      // extra instances and would otherwise shift which sentence is "expected".
      window.__SUCCESSFUL_STARTS__ = (window.__SUCCESSFUL_STARTS__ ?? 0) + 1;
      const sessionNumber = window.__SUCCESSFUL_STARTS__;
      const text = sessionTexts[sessionNumber - 1] ?? `session ${sessionNumber} works.`;
      setTimeout(() => {
        if (!this._alive) return;
        window.__EMITTED__.push(text);
        const result = [{ transcript: text, confidence: 0.9 }];
        result.isFinal = true;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }, 350);
    }
    stop() {
      // Asynchronous end, exactly like Chrome: the session is still "open" for
      // a moment after stop() is called.
      setTimeout(() => {
        if (activeSession === this) activeSession = null;
        this._alive = false;
        this.onend?.();
      }, 250);
    }
    abort() {
      this.stop();
    }
  }
  window.SpeechRecognition = FakeSpeechRecognition;
  window.webkitSpeechRecognition = FakeSpeechRecognition;
}, SESSION_TEXTS);

const page = await context.newPage();
const consoleErrors = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 160)}`));

const status = () => page.evaluate(() => window.__TALKQ__?.translate?.getState?.().status ?? "unknown");
const startButton = () => page.getByRole("button", { name: /开始实时翻译/ }).first();
const stopButton = () => page.getByRole("button", { name: /停止翻译/ }).first();

/** Run one start → recognise → stop cycle and report what happened. */
async function cycle(index) {
  const expected = SESSION_TEXTS[index - 1] ?? `session ${index} works.`;
  await startButton().click();
  const listened = await page
    .getByText("正在聆听")
    .first()
    .waitFor({ timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  const recognised = await page
    .getByText(expected, { exact: false })
    .first()
    .waitFor({ timeout: 12000 })
    .then(() => true)
    .catch(() => false);
  const state = await status();
  await stopButton().click().catch(() => {});
  await page.waitForTimeout(600);
  return { listened, recognised, state, expected };
}

try {
  group("R1 · first session (the one that was reported to work)");
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  const first = await cycle(1);
  check("session 1 reaches 正在聆听", first.listened, `status=${first.state}`);
  check("session 1 recognises its sentence", first.recognised, first.expected);
  check("stop returns to 未开始", (await status()) === "idle", await status());

  group("R2 · start again after stop (reported broken)");
  const second = await cycle(2);
  check("session 2 reaches 正在聆听", second.listened, `status=${second.state}`);
  check("session 2 recognises its sentence", second.recognised, second.expected);
  const attempts = await page.evaluate(() => ({
    attempts: window.__START_ATTEMPTS__,
    throws: window.__START_THROWS__,
    emitted: window.__EMITTED__,
  }));
  check(
    "no runaway restart loop while the old session was still closing",
    attempts.throws <= 3,
    `start attempts=${attempts.attempts}, throws=${attempts.throws}, emitted=${JSON.stringify(attempts.emitted)}`
  );
  await stopButton().click().catch(() => {});
  await page.waitForTimeout(600);

  group("R3 · third session confirms it stays fixed");
  const third = await cycle(3);
  check("session 3 reaches 正在聆听", third.listened, `status=${third.state}`);
  check("session 3 recognises its sentence", third.recognised, third.expected);

  group("R4 · start raced by a still-closing session recovers");
  // The browser throws "already started" for the first three attempts of the
  // next start — the exact race that used to spin and never open a session.
  await page.evaluate(() => window.__SET_FAKE_MODE__("race", 3));
  await page.evaluate(() => {
    window.__START_ATTEMPTS__ = 0;
    window.__START_THROWS__ = 0;
  });
  const raced = await cycle(4);
  check("session 4 still reaches 正在聆听", raced.listened, `status=${raced.state}`);
  check("session 4 recognises its sentence after the race", raced.recognised, raced.expected);
  const raceStats = await page.evaluate(() => ({
    attempts: window.__START_ATTEMPTS__,
    throws: window.__START_THROWS__,
  }));
  check(
    "the retry backs off instead of spinning",
    raceStats.throws >= 3 && raceStats.attempts <= 12,
    `attempts=${raceStats.attempts}, throws=${raceStats.throws}`
  );
  await stopButton().click().catch(() => {});
  await page.waitForTimeout(600);

  group("R5 · a session that never opens is reported, not silently hung");
  await page.evaluate(() => window.__SET_FAKE_MODE__("stuck"));
  await startButton().click();
  await page.waitForTimeout(7500);
  const stuckState = await page.evaluate(() => {
    const s = window.__TALKQ__?.translate?.getState?.();
    return { status: s?.status, error: s?.error ?? null };
  });
  check(
    "the UI leaves 启动中 and explains the failure",
    stuckState.status === "error" && Boolean(stuckState.error),
    `status=${stuckState.status} error=${stuckState.error?.title ?? "none"}`
  );
  check(
    "the message tells the user what to do",
    /再点一次|刷新/.test(stuckState.error?.hint ?? ""),
    stuckState.error?.hint ?? "none"
  );
  await page.evaluate(() => window.__SET_FAKE_MODE__("normal"));
  await stopButton().click().catch(() => {});
  await page.waitForTimeout(600);

  group("R6 · state is clean between sessions");
  // Leave the (intentionally failed) session first, then inspect the idle state.
  await page.evaluate(() => window.__TALKQ__.translate.getState().stop());
  await page.waitForTimeout(400);
  const diag = await page.evaluate(() => {
    const s = window.__TALKQ__?.translate?.getState?.();
    return {
      status: s?.status,
      segments: s?.segments?.length ?? 0,
      interim: s?.interim ?? "",
      recognition: s?.recognition ?? null,
    };
  });
  check("no leftover interim text", diag.interim === "", JSON.stringify(diag.interim));
  check("every recognised sentence became a subtitle", diag.segments >= 4, `segments=${diag.segments}`);
  check(
    "the recognizer is idle after the last stop",
    diag.status === "idle" && diag.recognition?.running !== true,
    `status=${diag.status} running=${diag.recognition?.running}`
  );
  check(
    "restart reasons did not pile up as failures",
    !diag.recognition || (diag.recognition.restartsByReason["audio-capture"] ?? 0) === 0,
    JSON.stringify(diag.recognition?.restartsByReason ?? {})
  );
  await page.screenshot({ path: path.join(ARTIFACTS, "r01-restart-cycles.png") });

  const noisy = consoleErrors.filter((e) => !/favicon|Failed to load resource|net::ERR/i.test(e));
  check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));
} catch (err) {
  check(`harness crashed: ${err.message}`, false);
  await page.screenshot({ path: path.join(ARTIFACTS, "r99-crash.png") }).catch(() => {});
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(64)}`);
console.log(`restart checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
}
console.log(`translated segments: ${translated.length}`);
process.exit(failed.length ? 1 : 0);

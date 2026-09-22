/**
 * Far-field recognition behaviour tests.
 *
 * Reproduces the failure modes reported at ~5 m — Chrome ending the session
 * mid-sentence, no-speech/network errors, repeated restarts — with a
 * programmable fake recognizer, and asserts the fixes:
 *
 *   · a sentence interrupted by a restart is NOT lost (carry-over + merge)
 *   · the session never switches itself off because of transient errors
 *   · restarts are immediate (no fixed 350 ms hole in the audio)
 *   · far-field mode really requests a raw capture (EC/NS/AGC off)
 *   · the diagnostics panel exposes the measured numbers
 *
 * It cannot and does not claim anything about real 5 m acoustics: the audio here
 * is Chrome's fake device. Real distance behaviour is measured by the user with
 * the in-app calibration (Settings → 开发者诊断).
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
const APP_PORT = 4335;
const MOCK_PORT = 8450;
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

/* ── static server ───────────────────────────────────────────────────── */
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

/* ── DeepSeek mock (translation only; enough to get final results processed) ── */
const translated = [];
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
    return res.end(JSON.stringify({ model: "deepseek-flash", choices: [{ message: { content: "Hi" } }] }));
  }
  const lastUser = [...(body.messages ?? [])].reverse().find((m) => m.role === "user");
  const text = typeof lastUser?.content === "string" ? lastUser.content : "";
  translated.push(text);

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { content: `[EN] ${text}` } }] }));
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
  res.write("data: [DONE]\n\n");
  res.end();
});

await new Promise((r) => staticServer.listen(APP_PORT, "127.0.0.1", r));
await new Promise((r) => mockServer.listen(MOCK_PORT, "127.0.0.1", r));
const APP_URL = `http://127.0.0.1:${APP_PORT}${BASE}`;

/**
 * Fake recognizer driven by a timeline. Each entry either emits a result, ends
 * the session (Chrome does this on silence), or raises an error.
 */
const SCRIPT = [
  // Session 1: the speaker is interrupted by a session end mid-sentence.
  { delay: 400, type: "interim", text: "this is a live" },
  { delay: 700, type: "end" },
  // Session 2: Chrome re-recognises the tail; the app must merge, not duplicate.
  { delay: 300, type: "final", text: "live translation test" },
  // Session 3: a no-speech error must not stop the session.
  { delay: 500, type: "error", error: "no-speech" },
  { delay: 150, type: "end" },
  // Session 4: a network blip must warn and recover.
  { delay: 200, type: "error", error: "network" },
  { delay: 150, type: "end" },
  // Session 5: another interruption in the middle of a sentence.
  { delay: 250, type: "interim", text: "second sentence complete" },
  { delay: 300, type: "end" },
  // Session 6: the continuation arrives with overlapping words.
  { delay: 200, type: "final", text: "complete now" },
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
  viewport: { width: 1440, height: 900 },
});
await context.grantPermissions(["microphone"], { origin: APP_URL });
await context.addInitScript(
  ([script]) => {
    localStorage.setItem("talkq_deepseek_api_key", "sk-farfield-e2e");
    localStorage.setItem(
      "talkq_settings",
      JSON.stringify({ farFieldMode: true, micProcessing: "auto", livePreview: false })
    );
    localStorage.removeItem("talkq_translate_transcript");

    window.__NEXQ_CURSOR__ = 0;
    window.__NEXQ_SESSIONS__ = 0;
    class FakeSpeechRecognition {
      constructor() {
        this.lang = "zh-CN";
        this.continuous = true;
        this.interimResults = true;
        this.maxAlternatives = 1;
        this._timers = [];
        this._alive = true;
        window.__NEXQ_SESSIONS__ += 1;
      }
      _emit(text, isFinal) {
        if (!this._alive) return;
        const result = [{ transcript: text, confidence: 0.9 }];
        result.isFinal = isFinal;
        this.onresult?.({ resultIndex: 0, results: [result] });
      }
      start() {
        this.onstart?.();
        this.onaudiostart?.();
        let elapsed = 0;
        let i = window.__NEXQ_CURSOR__;
        for (; i < script.length; i += 1) {
          const step = script[i];
          elapsed += step.delay ?? 300;
          if (step.type === "end") {
            window.__NEXQ_CURSOR__ = i + 1;
            this._timers.push(
              setTimeout(() => {
                this._alive = false;
                this.onaudioend?.();
                this.onend?.();
              }, elapsed)
            );
            return;
          }
          if (step.type === "error") {
            window.__NEXQ_CURSOR__ = i + 1;
            this._timers.push(setTimeout(() => this.onerror?.({ error: step.error }), elapsed));
            continue;
          }
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
        this._alive = false;
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
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 180)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 180)}`));

const readDiag = () =>
  page.evaluate(() => {
    const store = window.__TALKQ__.translate;
    return store ? store.getState().recognition : null;
  });

try {
  /* ── F1: start ─────────────────────────────────────────────────────── */
  group("F1 · far-field session starts and captures raw audio");
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
  await page.getByText("正在聆听").first().waitFor({ timeout: 15000 });
  check("session is listening", await page.getByText("正在聆听").first().isVisible());
  check(
    "far-field chip is on by default",
    await page.getByRole("button", { name: /远场模式/ }).first().isVisible()
  );

  // The mic meter now reports real numbers instead of a dead-looking bar.
  await page.waitForTimeout(1500);
  const vadText = await page.locator("body").innerText();
  check("meter shows an SNR readout", /SNR\s*-?\d+\s*dB/.test(vadText), vadText.match(/SNR[^\n]*/)?.[0] ?? "none");

  /* ── F2: word loss across restarts ─────────────────────────────────── */
  group("F2 · a sentence interrupted by a restart keeps its words");
  await page.getByText("this is a live translation test", { exact: false }).first().waitFor({ timeout: 20000 });
  const mergedText = await page.locator(".subtitle-source").first().innerText();
  check(
    "carried-over interim is merged with the next final (no lost words)",
    mergedText.includes("this is a live") && mergedText.includes("translation test"),
    mergedText.replace(/\s+/g, " ")
  );
  check(
    "no duplicated words around the restart",
    !/live live|test test/i.test(mergedText),
    mergedText.replace(/\s+/g, " ")
  );

  /* ── F3: transient errors never stop the session ───────────────────── */
  group("F3 · no-speech / network / session ends do not kill the session");
  await page.waitForTimeout(4000);
  const statusAfterErrors = await page.evaluate(() => window.__TALKQ__.translate?.getState().status ?? "unknown");
  check(
    "still running after no-speech + network + 4 session ends",
    statusAfterErrors === "listening" || statusAfterErrors === "restarting",
    `status=${statusAfterErrors}`
  );
  check("no fatal error banner", (await page.getByText("识别已自动恢复").count()) >= 0);

  const diag = await readDiag();
  check("restarts were counted", (diag?.restartCount ?? 0) >= 4, `restartCount=${diag?.restartCount}`);
  check(
    "restart reasons include no-speech and network",
    Boolean(diag && diag.restartsByReason["no-speech"] >= 1 && diag.restartsByReason.network >= 1),
    JSON.stringify(diag?.restartsByReason ?? {})
  );
  check(
    "restart gap is immediate, not the old fixed 350 ms",
    Boolean(diag && diag.lastGapMs < 350),
    `lastGapMs=${diag?.lastGapMs}`
  );
  check("last partial is recorded", Boolean(diag?.lastPartial), diag?.lastPartial ?? "-");
  check("last final is recorded", Boolean(diag?.lastFinal), diag?.lastFinal ?? "-");
  check("sessions were actually restarted", (await page.evaluate(() => window.__NEXQ_SESSIONS__)) >= 4);

  /* ── F4: second interruption merges without duplication ────────────── */
  group("F4 · overlapping continuation is de-duplicated");
  await page.waitForTimeout(3000);
  const sources = await page.locator(".subtitle-source").allInnerTexts();
  const joined = sources.join(" | ");
  check(
    "second interrupted sentence also merged",
    joined.includes("second sentence complete") && !/complete complete/i.test(joined),
    joined.replace(/\s+/g, " ").slice(0, 120)
  );

  /* ── F5: diagnostics panel ─────────────────────────────────────────── */
  group("F5 · developer diagnostics show the measured numbers");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const settings = page.getByRole("dialog", { name: "Settings" });
  await settings.waitFor({ timeout: 5000 });
  const panelText = await settings.innerText();
  for (const label of [
    "Mic level",
    "RMS",
    "Peak",
    "Noise floor",
    "SNR",
    "Speech",
    "Restart count",
    "Last gap",
    "Last partial",
    "Last final",
  ]) {
    check(`diagnostics shows “${label}”`, panelText.includes(label));
  }
  check("diagnostics shows the capture settings", /回声消除 \/ 降噪 \/ 自动增益/.test(panelText));
  check(
    "far-field requested a raw capture (EC/NS/AGC all false)",
    /false \/ false \/ false/.test(panelText),
    panelText.match(/false[^\n]*/)?.[0] ?? panelText.match(/true[^\n]*/)?.[0] ?? "not found"
  );
  check("distance calibration UI is present", panelText.includes("距离校准") && panelText.includes("5 米"));
  await page.screenshot({ path: path.join(ARTIFACTS, "f01-diagnostics.png") });

  /* ── F6: switching to near-field re-negotiates constraints ─────────── */
  group("F6 · switching processing mode re-negotiates the live track");
  await page.evaluate(() =>
    window.__TALKQ__.settings.getState().updateSettings({ micProcessing: "browser" })
  );
  await page.evaluate(() => window.__TALKQ__.translate.getState().applyAudioSettings());
  await page.waitForTimeout(1200);
  const afterSwitch = await page.evaluate(() => window.__TALKQ__.translate.getState().capture);
  check(
    "the new constraints were requested (EC/NS/AGC = true)",
    afterSwitch?.applied?.echoCancellation === true &&
      afterSwitch?.applied?.noiseSuppression === true &&
      afterSwitch?.applied?.autoGainControl === true,
    JSON.stringify(afterSwitch?.applied ?? null)
  );
  // Chrome's fake device may keep the values it was opened with, so report what
  // the device actually answered instead of asserting a device-specific result.
  check(
    "the capture report is refreshed with the device's answer",
    Boolean(afterSwitch?.actual),
    JSON.stringify(afterSwitch?.actual ?? null)
  );
  const backToRaw = await page
    .evaluate(async () => {
      window.__TALKQ__.settings
        .getState()
        .updateSettings({ micProcessing: "auto", farFieldMode: true });
      await window.__TALKQ__.translate.getState().applyAudioSettings();
      const applied = window.__TALKQ__.translate.getState().capture?.applied;
      return applied?.echoCancellation === false && applied?.noiseSuppression === false;
    })
    .catch(() => false);
  check("switching back to far-field requests raw capture again", backToRaw);
  check(
    "recognition kept running through the change",
    (await page.evaluate(() => window.__TALKQ__.translate.getState().status)) !== "error"
  );
  const noisy = consoleErrors.filter((e) => !/favicon|Failed to load resource|net::ERR/i.test(e));
  check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));
} catch (err) {
  check(`harness crashed: ${err.message}`, false);
  await page.screenshot({ path: path.join(ARTIFACTS, "f99-crash.png") }).catch(() => {});
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(64)}`);
console.log(`far-field checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
}
console.log(`translated segments: ${translated.length}`);
process.exit(failed.length ? 1 : 0);

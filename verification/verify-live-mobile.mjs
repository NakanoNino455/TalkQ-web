/**
 * Live mobile check: the deployed GitHub Pages URL in a phone viewport.
 *
 * Fake mic + programmable fake recognizer + a local TLS mock of
 * api.deepseek.com, driven through Chromium's host-resolver rules. Proves the
 * phone layout, the share→ask jump and the overflow sheet work on the real
 * deployed bundle — not just locally.
 *
 * Optional tooling: npm i -D playwright-core selfsigned
 * Override the target: node verify-live-mobile.mjs https://your.site/nexq-web/
 */
import { createServer } from "node:https";
import path from "node:path";
import { mkdirSync } from "node:fs";

let selfsigned;
let chromium;
try {
  ({ default: selfsigned } = await import("selfsigned"));
  ({ chromium } = await import("playwright-core"));
} catch {
  console.error(
    "This optional harness needs its dev-only tools:\n  npm i -D playwright-core selfsigned"
  );
  process.exit(2);
}

const LIVE_URL = process.argv[2] ?? "https://nakanonino455.github.io/nexq-web/";
const LIVE_ORIGIN = new URL(LIVE_URL).origin;
const MOCK_PORT = 8448;
const PHONE = { width: 390, height: 844 };
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const TRANSLATIONS = {
  "你好，这是一次实时翻译测试。": "Hello, this is a live translation test.",
  "English sentence for auto detection.": "这是一句用于自动检测方向的英文。",
};
const askTexts = [];
const askSystems = [];

const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});
const mock = createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
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
  if (!isTranslation) {
    askTexts.push(text);
    askSystems.push(systems);
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
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

const SCRIPT = [
  { delay: 400, type: "interim", text: "你好，这是一次实时翻译测试" },
  { delay: 2000, type: "final", text: "你好，这是一次实时翻译测试。" },
  { delay: 500, type: "interim", text: "English sentence" },
  { delay: 800, type: "final", text: "English sentence for auto detection." },
];

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT}`,
    // Harness-only: public page → local mock is blocked by Chrome's Local
    // Network Access check in headless. Production talks to a public IP.
    "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests," +
      "PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights",
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
await context.grantPermissions(["microphone"], { origin: LIVE_ORIGIN });
await context.addInitScript(
  ([script]) => {
    if (!sessionStorage.getItem("nexq-live-mobile-seeded")) {
      localStorage.setItem("talkq_deepseek_api_key", "sk-live-mobile-check");
      localStorage.setItem(
        "talkq_settings",
        JSON.stringify({ livePreview: true, translateQuickMode: true })
      );
      localStorage.removeItem("talkq_translate_transcript");
      sessionStorage.setItem("nexq-live-mobile-seeded", "1");
    }
    window.__NEXQ_CURSOR__ = window.__NEXQ_CURSOR__ ?? 0;
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

console.log(`opening ${LIVE_URL} at ${PHONE.width}×${PHONE.height}\n`);
const response = await page.goto(LIVE_URL, { waitUntil: "networkidle", timeout: 60000 });
check("live URL returns 200", response?.status() === 200, `HTTP ${response?.status()}`);
check("no horizontal overflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
check("desktop sidebar not rendered", (await page.locator("aside").count()) === 0);

const tabs = page.locator('nav[aria-label="主导航"]');
check("bottom tab bar rendered", await tabs.isVisible());
const tabBox = await tabs.boundingBox();
check("tab bar pinned to the bottom", tabBox && tabBox.y + tabBox.height <= PHONE.height + 1, JSON.stringify(tabBox));

await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
await page.getByText("正在聆听").first().waitFor({ timeout: 15000 }).catch(() => {});
check("microphone works on mobile live", await page.getByText("正在聆听").first().isVisible());
await page.getByText("你好，这是一次实时翻译测试。").first().waitFor({ timeout: 20000 });
check("live mobile subtitle rendered", await page.getByText("Hello, this is a live translation test.").first().isVisible({ timeout: 15000 }));

/* Overflow sheet on the deployed build: must be tappable, not covered. */
await page.getByRole("button", { name: "更多操作" }).click();
await page.waitForTimeout(300);
check(
  "menu is a body-level sheet",
  await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"][aria-label="更多操作"]');
    return Boolean(dialog && dialog.parentElement === document.body);
  })
);
let dialogRaised = false;
page.once("dialog", (d) => {
  dialogRaised = true;
  void d.dismiss();
});
const tapped = await page
  .getByRole("button", { name: "清空字幕" })
  .click({ timeout: 8000 })
  .then(() => true)
  .catch(() => false);
check("清空字幕 is tappable on the live site", tapped);
await page.waitForTimeout(500);
check("tapping it raised the confirm dialog", dialogRaised);
await page.screenshot({ path: path.join(ARTIFACTS, "live-mobile-sheet.png") });

await page.getByText("English sentence for auto detection.").first().waitFor({ timeout: 20000 });
const shareButtons = page.locator('button[aria-label="分享到问答（自动发送英文）"]');
check("share buttons present on mobile", (await shareButtons.count()) >= 2, `${await shareButtons.count()}`);
await shareButtons.last().click();
await page.getByText("结合刚才的字幕", { exact: false }).first().waitFor({ timeout: 20000 }).catch(() => {});
check("share switched to the 问答 tab", await page.locator('aside[aria-label="问答"]').isVisible());
check("share sent only the English", askTexts.at(-1) === "English sentence for auto detection.", JSON.stringify(askTexts.at(-1) ?? null));
check(
  "context attached on mobile too",
  askSystems.some((systems) => systems.some((s) => s.includes("【实时翻译字幕上下文】") && /\n\d+\. \S/.test(s)))
);
const composerBox = await page.locator('aside[aria-label="问答"] textarea').first().boundingBox();
check("composer inside the viewport", composerBox && composerBox.y + composerBox.height <= PHONE.height - 40, JSON.stringify(composerBox));

await tabs.getByRole("button", { name: /^字幕/ }).click();
await page.waitForTimeout(400);
check("tab switch back keeps the subtitles", await page.getByText("你好，这是一次实时翻译测试。").first().isVisible());

const noisy = consoleErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));

await page.screenshot({ path: "artifacts/live-mobile.png" });
await browser.close();
mock.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nlive mobile checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
process.exit(failed.length ? 1 : 0);

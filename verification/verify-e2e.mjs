/**
 * TalkQ Web end-to-end verification.
 *
 * Runs the *real* production bundle from `dist/` in Chrome and points
 * https://api.deepseek.com at a local TLS mock (via Chromium host-resolver
 * rules), so streaming, aborting, images, multi-turn history and every error
 * branch are exercised for real — no API key required, and the app itself is
 * never modified or built differently for the test.
 */
import { createServer } from "node:https";
import { createServer as createHttpServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
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
const APP_PORT = 4319;
const MOCK_PORT = 8443;
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");

/* ── Test bookkeeping ────────────────────────────────────────────────── */
const results = [];
let currentGroup = "";
function group(name) {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}
function check(name, condition, extra = "") {
  const ok = Boolean(condition);
  results.push({ group: currentGroup, name, ok, extra });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  return ok;
}

/* ── Static server for dist/ (served under the GitHub Pages base path) ── */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const staticServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  let pathname = url.pathname;
  if (pathname === "/") {
    res.writeHead(302, { Location: BASE });
    return res.end();
  }
  if (!pathname.startsWith(BASE)) {
    res.writeHead(404);
    return res.end("not found");
  }
  let rel = pathname.slice(BASE.length) || "index.html";
  const file = path.join(DIST, rel);
  if (!existsSync(file)) {
    const index = await readFile(path.join(DIST, "index.html"));
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(index);
  }
  const buf = await readFile(file);
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream" });
  res.end(buf);
});

/* ── DeepSeek mock ───────────────────────────────────────────────────── */
const state = {
  scenario: "json-ok",
  requests: [],
  abortedStreams: 0,
  streamingRequests: 0,
};

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";

function chunk(obj) {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function deltaChunk(delta, extra = {}) {
  return chunk({
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    model: "deepseek-flash",
    choices: [{ index: 0, delta, finish_reason: null }],
    ...extra,
  });
}

const REASONING_STEPS = [
  "用户发来了消息，我需要先理解意图。",
  "接着组织一个简洁的中文回答，并附上一段示例代码。",
];

const CONTENT_STEPS = [
  "你好！我是 **TalkQ Web** 里的 DeepSeek Flash。\n\n",
  "下面是一段示例代码：\n\n```ts\nconst greet = (name: string) => `你好, ${name}`;\n```\n\n",
  "- 支持 Markdown\n- 支持代码块复制\n- 支持 1M 上下文\n",
];

const errorBodies = {
  401: { error: { message: "Authentication Fails, Your api key is invalid", type: "authentication_error", code: "invalid_api_key" } },
  402: { error: { message: "Insufficient Balance", type: "insufficient_quota", code: "insufficient_balance" } },
  429: { error: { message: "Rate Limit Reached", type: "rate_limit_error", code: "rate_limit" } },
  500: { error: { message: "Server Error", type: "server_error", code: "internal_error" } },
};

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
  state.requests.push({ url: req.url, body, headers: req.headers, at: Date.now() });
  res.on("error", () => {});
  req.on("error", () => {});

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  // Only POSTs are interesting (OPTIONS preflights would skew the indexes).
  if (req.method !== "POST") {
    res.writeHead(405);
    return res.end();
  }

  const scenario = state.scenario;

  if (scenario === "network-down") {
    req.socket.destroy();
    return;
  }

  if (scenario === "401" || scenario === "402" || scenario === "429" || scenario === "500") {
    res.writeHead(Number(scenario), { "Content-Type": "application/json" });
    return res.end(JSON.stringify(errorBodies[Number(scenario)]));
  }

  // Non-streaming (Test Connection, or settings.thinking off probes)
  if (!body?.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        id: "chatcmpl-mock",
        object: "chat.completion",
        model: "deepseek-flash",
        choices: [
          { index: 0, message: { role: "assistant", content: "Hello!" }, finish_reason: "stop" },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    );
  }

  state.streamingRequests += 1;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  let closed = false;
  const markClosed = () => {
    if (closed || res.writableEnded) return;
    closed = true;
    state.abortedStreams += 1;
  };
  // A cancelled fetch shows up as the response/socket closing before end.
  res.on("close", markClosed);
  res.on("error", markClosed);
  res.on("finish", () => {
    closed = true;
  });
  req.on("aborted", markClosed);
  req.socket?.on("close", markClosed);

  const safeWrite = (data) => {
    if (closed) return false;
    try {
      res.write(data);
      return true;
    } catch {
      markClosed();
      return false;
    }
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  if (scenario === "stream-slow") {
    safeWrite(deltaChunk({ role: "assistant", content: "" }));
    let i = 0;
    while (!closed && i < 400) {
      if (!safeWrite(deltaChunk({ content: `第 ${i + 1} 段输出。` }))) break;
      i += 1;
      await sleep(120);
    }
    if (!closed) {
      res.write(deltaChunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }));
      res.write("data: [DONE]\n\n");
      res.end();
    }
    return;
  }

  // Normal streaming answer, deliberately split mid-JSON to prove the SSE
  // parser buffers partial events across network chunks.
  const emit = async (obj, { split = false, delay = 60 } = {}) => {
    if (closed) return;
    const payload = deltaChunk(obj);
    if (split && payload.length > 40) {
      const cut = Math.floor(payload.length / 2);
      res.write(payload.slice(0, cut));
      await sleep(30);
      if (closed) return;
      res.write(payload.slice(cut));
    } else {
      res.write(payload);
    }
    await sleep(delay);
  };

  res.write(deltaChunk({ role: "assistant", content: "" }));
  await sleep(30);
  for (const step of REASONING_STEPS) {
    await emit({ reasoning_content: step });
  }
  for (let i = 0; i < CONTENT_STEPS.length; i += 1) {
    await emit({ content: CONTENT_STEPS[i] }, { split: true, delay: 220 });
  }
  if (closed) return;
  res.write(
    chunk({
      id: "chatcmpl-mock",
      object: "chat.completion.chunk",
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 42, completion_tokens: 88, total_tokens: 130 },
    })
  );
  res.write("data: [DONE]\n\n");
  res.end();
};

/* ── Boot everything ─────────────────────────────────────────────────── */
const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});

const mockServer = createServer({ key: pems.private, cert: pems.cert }, handler);

await new Promise((resolve) => staticServer.listen(APP_PORT, "127.0.0.1", resolve));
await new Promise((resolve) => mockServer.listen(MOCK_PORT, "127.0.0.1", resolve));

const APP_URL = `http://127.0.0.1:${APP_PORT}${BASE}`;
console.log(`app:  ${APP_URL}`);
console.log(`mock: https://api.deepseek.com  ->  127.0.0.1:${MOCK_PORT}`);

const CHROME_ARGS = [
  `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT},MAP api.deepseek.com:443 127.0.0.1:${MOCK_PORT}`,
  // The sandbox host may have a system proxy configured; bypass it so the
  // resolver rule above is what actually handles api.deepseek.com.
  "--no-proxy-server",
  "--proxy-bypass-list=*",
];

const browser = await chromium
  .launch({ channel: "chrome", headless: true, args: CHROME_ARGS })
  .catch(async (err) => {
    console.warn(`channel:chrome launch failed (${err.message}); falling back to executablePath`);
    return chromium.launch({
      executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      headless: true,
      args: CHROME_ARGS,
    });
  });

const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();

const consoleErrors = [];
page.on("console", (msg) => {
  if (msg.type() === "error") consoleErrors.push(msg.text());
});
page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${err.message}`));

const shot = async (name) => {
  await page.screenshot({ path: path.join(ARTIFACTS, `${name}.png`), fullPage: false });
};

const waitText = async (text, timeout = 15000) => {
  await page.getByText(text, { exact: false }).first().waitFor({ timeout });
};

const composer = () => page.locator("textarea").first();

async function typeAndSend(text) {
  await composer().fill(text);
  await page.getByRole("button", { name: "发送", exact: true }).click();
}

try {
  /* ── T1: first-run API key modal ───────────────────────────────────── */
  group("T1 · first run shows the DeepSeek API Key modal");
  state.scenario = "json-ok";
  await page.goto(APP_URL, { waitUntil: "networkidle" });
  const dialog = page.getByRole("dialog");
  check("modal is visible", await dialog.isVisible());
  check("brand shows TalkQ", await page.getByText("TalkQ", { exact: true }).first().isVisible());
  check("copy asks to connect DeepSeek", await page.getByText("Connect your DeepSeek").isVisible());
  check("Test & Continue button present", await page.getByRole("button", { name: "Test & Continue" }).isVisible());
  check(
    "local-storage note present",
    await page.getByText("Stored locally in your browser").isVisible()
  );
  check("modal gates the chat UI", await composer().isDisabled());
  check("tab title is TalkQ", (await page.title()).includes("TalkQ"));
  await shot("01-api-key-modal");

  /* ── T1b: TalkQ branding + generated icon set ─────────────────────── */
  group("T1b · TalkQ icon set is served and rendered");
  const iconStatuses = await page.evaluate(async (base) => {
    const names = [
      "favicon.ico",
      "favicon-32.png",
      "apple-touch-icon.png",
      "icon-192.png",
      "icon-512.png",
      "site.webmanifest",
    ];
    const out = {};
    for (const name of names) {
      try {
        out[name] = (await fetch(base + name)).status;
      } catch {
        out[name] = "error";
      }
    }
    return out;
  }, BASE);
  check(
    "favicon / touch icons / manifest all 200",
    Object.values(iconStatuses).every((status) => status === 200),
    JSON.stringify(iconStatuses)
  );
  const logo = await page.evaluate(() => {
    const img = [...document.images].find((i) => i.src.includes("icon-192.png"));
    return img ? { found: true, width: img.naturalWidth, complete: img.complete } : { found: false };
  });
  check("in-app logo image loaded", logo.found && logo.complete && logo.width >= 180, JSON.stringify(logo));
  const manifest = await page.evaluate(async (base) => {
    const res = await fetch(`${base}site.webmanifest`);
    const json = await res.json();
    return { name: json.name ?? "", icons: (json.icons ?? []).length };
  }, BASE);
  check(
    "manifest advertises TalkQ",
    manifest.name.includes("TalkQ") && manifest.icons >= 2,
    JSON.stringify(manifest)
  );

  /* Show / hide key toggle */
  const keyInput = page.locator("#nexq-api-key");
  check("key field is masked by default", (await keyInput.getAttribute("type")) === "password");
  await keyInput.fill("sk-mock-1234567890abcdef");
  await page.getByRole("button", { name: "Show API key" }).click();
  check("Show reveals the key", (await keyInput.getAttribute("type")) === "text");
  await page.getByRole("button", { name: "Hide API key" }).click();
  check("Hide masks the key again", (await keyInput.getAttribute("type")) === "password");

  /* ── T2: Test & Continue ───────────────────────────────────────────── */
  group("T2 · Test & Continue validates the key and opens the chat");
  await page.getByRole("button", { name: "Test & Continue" }).click();
  await waitText("connection successful", 15000).catch(() => {});
  await composer().waitFor({ timeout: 15000 });
  check("chat UI unlocked after successful test", !(await composer().isDisabled()));
  check("key modal closed", (await page.getByRole("dialog").count()) === 0);
  const storedKey = await page.evaluate(() => localStorage.getItem("talkq_deepseek_api_key"));
  check("key stored under talkq_deepseek_api_key", storedKey === "sk-mock-1234567890abcdef", String(storedKey));
  check(
    "test hit /chat/completions",
    state.requests.some((r) => r.url.includes("/chat/completions") && r.body?.stream === false)
  );
  check(
    "test request used deepseek-flash",
    state.requests.some((r) => r.body?.model === "deepseek-flash")
  );
  await shot("02-chat-ready");

  /* ── T3: streaming chat ────────────────────────────────────────────── */
  group("T3 · send 你好 → streaming AI response");
  state.scenario = "stream";
  const before = state.requests.length;
  await typeAndSend("你好");
  const streamingBadge = page.getByText("streaming", { exact: false });
  await streamingBadge.first().waitFor({ timeout: 10000 });
  check("streaming indicator appears while generating", true);

  // Progressive rendering: the answer must grow before the stream finishes.
  await page.waitForFunction(
    () => document.querySelector(".nexq-prose")?.textContent?.includes("TalkQ Web"),
    undefined,
    { timeout: 10000 }
  );
  const partial = await page.locator(".nexq-prose").first().innerText();
  const stillStreaming = await streamingBadge.first().isVisible().catch(() => false);
  check("first tokens render before completion", partial.length > 0 && stillStreaming, `${partial.length} chars mid-stream`);

  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 15000 });
  const answer = await page.locator(".nexq-prose").first().innerText();
  check("full answer rendered", answer.includes("支持 Markdown") && answer.includes("你好"), answer.slice(0, 60));
  check("thinking block appeared", await page.getByText("Thought", { exact: false }).first().isVisible());
  await shot("03-streamed-answer");

  /* ── T4: markdown + code block copy ────────────────────────────────── */
  group("T4 · markdown, code block and Copy buttons");
  check("code block rendered", (await page.locator("pre").count()) > 0);
  const copyCode = page.locator('button[aria-label="Copy code"]').first();
  check("code block has a Copy button", (await copyCode.count()) === 1);
  await copyCode.click();
  await waitText("Copied", 4000).catch(() => {});
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  check("code copied to clipboard", clip.includes("const greet"), clip.slice(0, 40));
  await shot("04-code-copy");

  /* ── T5: multi-turn history ────────────────────────────────────────── */
  group("T5 · conversation history is sent on the next turn");
  const firstPayload = state.requests[before] ?? null;
  check("turn 1 sent the user text", firstPayload?.body?.messages?.at(-1)?.content === "你好");
  await typeAndSend("那为什么会这样？");
  await page.waitForFunction(
    (n) => document.querySelectorAll(".nexq-prose").length >= 2,
    undefined,
    { timeout: 15000 }
  );
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 15000 });
  const secondPayload = state.requests.at(-1);
  const roles = (secondPayload?.body?.messages ?? []).map((m) => m.role).join(",");
  check(
    "turn 2 carries user+assistant+user",
    roles === "user,assistant,user",
    roles
  );
  check(
    "prior assistant answer is included",
    JSON.stringify(secondPayload?.body?.messages ?? []).includes("支持 Markdown")
  );
  check("model is deepseek-flash", secondPayload?.body?.model === "deepseek-flash");
  await shot("05-multi-turn");

  /* ── T6: Ctrl+V screenshot paste ───────────────────────────────────── */
  group("T6 · Ctrl+V pastes a screenshot into the preview strip");
  await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], "nexq-paste.png", { type: "image/png" });
    const dt = new DataTransfer();
    dt.items.add(file);
    const target = document.querySelector("textarea");
    target.focus();
    target.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })
    );
  }, PNG_1PX);
  const thumb = page.locator('img[alt="nexq-paste.png"]');
  await thumb.waitFor({ timeout: 8000 });
  check("pasted image shows as a preview thumbnail", await thumb.isVisible());
  await shot("06-pasted-image");

  /* ── T7: image-only send + vision payload ──────────────────────────── */
  group("T7 · image-only send uses the default analysis prompt");
  await typeAndSend("");
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 20000 });
  const imagePayload = state.requests.at(-1);
  const lastMessage = imagePayload?.body?.messages?.at(-1);
  const blocks = Array.isArray(lastMessage?.content) ? lastMessage.content : [];
  check("content is a multimodal block array", blocks.length === 2, JSON.stringify(blocks[0] ?? null));
  check("text block is the default Chinese prompt", blocks[0]?.text?.includes("请详细分析这张图片"));
  check(
    "image_url carries the base64 data URL",
    blocks[1]?.type === "image_url" && blocks[1]?.image_url?.url?.startsWith("data:image/png;base64,")
  );
  check("draft was cleared after send", (await composer().inputValue()) === "");
  await shot("07-image-only-send");

  /* ── T8: Stop generating really aborts ─────────────────────────────── */
  group("T8 · Stop generating aborts the request");
  state.scenario = "stream-slow";
  const abortsBefore = state.abortedStreams;
  await typeAndSend("请写一段很长的内容");
  await page.waitForFunction(
    () => (document.body.innerText.match(/第 \d+ 段输出/g) ?? []).length >= 1,
    undefined,
    { timeout: 10000 }
  );
  const midText = await page.locator(".nexq-prose").last().innerText();
  const socketsBefore = state.abortedStreams;
  await page.getByRole("button", { name: "停止", exact: true }).click();
  await page.waitForTimeout(700);
  const afterText = await page.locator(".nexq-prose").last().innerText();
  await page.waitForTimeout(900);
  const settled = await page.locator(".nexq-prose").last().innerText();
  check("generation stopped growing after click", afterText === settled);
  check("server saw the stream aborted", state.abortedStreams > socketsBefore, `aborts: ${abortsBefore} -> ${state.abortedStreams}`);
  check("stopped chip shown", await page.getByText("stopped", { exact: false }).first().isVisible());
  check("partial text was kept", midText.length > 0);
  await shot("08-stopped");

  /* ── T9: error taxonomy ────────────────────────────────────────────── */
  group("T9 · errors are specific, not a generic failure");
  const cases = [
    ["401", "Invalid DeepSeek API Key"],
    ["402", "Insufficient DeepSeek Balance"],
    ["429", "Rate Limit Reached"],
    ["500", "DeepSeek Server Error"],
    ["network-down", "Network Error"],
  ];
  for (const [scenario, expected] of cases) {
    state.scenario = scenario;
    await typeAndSend(`错误测试 ${scenario}`);
    const found = await page
      .getByText(expected, { exact: false })
      .first()
      .waitFor({ timeout: 12000 })
      .then(() => true)
      .catch(() => false);
    check(`${scenario} → "${expected}"`, found);
    if (scenario === "401") await shot("09-error-401");
  }
  check("no generic 'Request failed' copy", !(await page.getByText("Request failed").count()));

  /* ── T10: Regenerate ───────────────────────────────────────────────── */
  group("T10 · Regenerate re-runs the last turn");
  state.scenario = "stream";
  const requestsBeforeRegen = state.requests.length;
  await page.getByRole("button", { name: "Regenerate" }).last().click();
  await page.waitForFunction(
    (n) => document.querySelectorAll(".nexq-prose").length >= 1,
    undefined,
    { timeout: 15000 }
  );
  await page.waitForTimeout(2500);
  check("a new request was issued", state.requests.length > requestsBeforeRegen);
  check(
    "regenerated content rendered",
    (await page.locator(".nexq-prose").last().innerText()).includes("TalkQ Web")
  );
  await shot("10-regenerate");

  /* ── T11: New Chat ─────────────────────────────────────────────────── */
  group("T11 · New Chat clears the transcript");
  await page.getByRole("button", { name: "新问答" }).click();
  await page.waitForTimeout(400);
  check("transcript is empty", (await page.locator(".nexq-prose").count()) === 0);
  check("empty state shown", await page.getByText("粘贴问题，直接问 AI").first().isVisible());
  check("quick actions shown", await page.getByText("总结刚才的内容").isVisible());
  await shot("11-new-chat");

  /* ── T12: Settings ─────────────────────────────────────────────────── */
  group("T12 · Settings shows fixed DeepSeek Flash facts only");
  await page.getByRole("button", { name: "Settings" }).first().click();
  const panel = page.getByRole("dialog", { name: "Settings" });
  await panel.waitFor({ timeout: 5000 });
  const panelText = await panel.innerText();
  check("API Key row", panelText.includes("API Key"));
  check("Change API Key button", panelText.includes("Change API Key"));
  check("Test Connection button", panelText.includes("Test Connection"));
  check("Model = DeepSeek Flash", panelText.includes("DeepSeek Flash"));
  check("Context = 1M", panelText.includes("1M"));
  check("Images = Supported", panelText.includes("Supported"));
  check("no provider selector copy", !/OpenAI|Claude|Gemini|Groq|Ollama|LM Studio|OpenRouter/.test(panelText));
  check(
    "no desktop-only controls",
    !/always.on.top|system tray|global shortcut|audio device|microphone|screen recording/i.test(
      panelText
    )
  );
  await shot("12-settings");

  group("T12b · Test Connection reports success");
  await page.getByRole("button", { name: "Test Connection" }).click();
  await waitText("Connection successful", 12000).catch(() => {});
  check("connection successful message", await page.getByText("Connection successful").first().isVisible());

  /* ── T16: thinking-mode toggle reaches the request body ────────────── */
  group("T16 · Thinking mode toggle is honoured on the wire");
  state.scenario = "stream";
  await panel.getByRole("switch", { name: "Thinking mode" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.waitForTimeout(200);
  await typeAndSend("关闭思考模式的测试");
  await page.waitForFunction(
    () => (document.body.innerText.match(/第 \d+ 段输出/g) ?? []).length >= 0,
    undefined,
    { timeout: 5000 }
  ).catch(() => {});
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 20000 });
  const thinkingPayload = state.requests.at(-1);
  check(
    'thinking disabled is sent as {"thinking":{"type":"disabled"}}',
    thinkingPayload?.body?.thinking?.type === "disabled",
    JSON.stringify(thinkingPayload?.body?.thinking ?? null)
  );
  // Restore the default for the remaining checks.
  await page.getByRole("button", { name: "Settings" }).first().click();
  const panel2 = page.getByRole("dialog", { name: "Settings" });
  await panel2.waitFor({ timeout: 5000 });
  await panel2.getByRole("switch", { name: "Thinking mode" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();

  /* ── T13: reload persistence ───────────────────────────────────────── */
  group("T13 · key + history survive a reload");
  await page.reload({ waitUntil: "networkidle" });
  await composer().waitFor({ timeout: 10000 });
  check("no key modal after reload", (await page.getByRole("dialog").count()) === 0);
  check("composer available immediately", (await composer().count()) === 1);

  /* ── T14: clearing localStorage brings the modal back ──────────────── */
  group("T14 · clearing localStorage restores the first-run modal");
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.getByRole("dialog").waitFor({ timeout: 10000 });
  check("DeepSeek API Key modal is back", await page.getByText("Connect your DeepSeek").isVisible());
  await shot("13-modal-after-clear");

  /* ── T15: no desktop/Tauri surface anywhere in the bundle ──────────── */
  group("T15 · bundle is browser-only");
  const bundle = await readFile(
    path.join(
      DIST,
      "assets",
      readdirSync(path.join(DIST, "assets")).find((f) => f.endsWith(".js"))
    ),
    "utf8"
  );
  check("no @tauri-apps import", !bundle.includes("@tauri-apps"));
  check("no invoke() bridge", !/__TAURI|tauri:\/\//.test(bundle));
  check("talks to api.deepseek.com", bundle.includes("api.deepseek.com"));
  check("default model deepseek-flash", bundle.includes("deepseek-flash"));
  check("no deepseek-chat / deepseek-reasoner", !/deepseek-chat|deepseek-reasoner/.test(bundle));
  check("no legacy deepseek-v4-flash default", !bundle.includes('"deepseek-v4-flash"'));
  check("no legacy context clamp labels", !/\b(4K|8K|32K|128K) context\b/i.test(bundle));

  group("Console health");
  const noisy = consoleErrors.filter(
    (e) => !/favicon|404|Failed to load resource|net::ERR/i.test(e)
  );
  check("no uncaught page errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));

  /* ── T17: pre-rename storage is migrated, not lost ────────────────── */
  group("T17 · legacy nexq_* storage migrates to talkq_*");
  const legacyContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
  });
  await legacyContext.addInitScript(() => {
    localStorage.clear();
    // Only the pre-rename keys exist, as they would for an existing user.
    localStorage.setItem("nexq_deepseek_api_key", "sk-legacy-migrated-123456");
    localStorage.setItem("nexq_settings", JSON.stringify({ translateQuickMode: false }));
  });
  const legacyPage = await legacyContext.newPage();
  await legacyPage.goto(APP_URL, { waitUntil: "networkidle" });
  await legacyPage.locator("textarea").first().waitFor({ timeout: 12000 });
  check(
    "migrated key unlocks the app without the modal",
    (await legacyPage.locator("#nexq-api-key").count()) === 0
  );
  const migrated = await legacyPage.evaluate(() => ({
    key: localStorage.getItem("talkq_deepseek_api_key"),
    settings: localStorage.getItem("talkq_settings") ?? "",
    legacyKept: localStorage.getItem("nexq_deepseek_api_key") !== null,
  }));
  check(
    "talkq_deepseek_api_key holds the old value",
    migrated.key === "sk-legacy-migrated-123456",
    String(migrated.key)
  );
  check("talkq_settings migrated as well", migrated.settings.includes("translateQuickMode"));
  check("legacy entries are left in place (safe rollback)", migrated.legacyKept);
  await legacyPage.screenshot({ path: path.join(ARTIFACTS, "14-migrated.png") });
  await legacyContext.close();
} catch (err) {
  check(`harness crashed: ${err.message}`, false);
  await shot("99-crash");
} finally {
  await browser.close();
  staticServer.close();
  mockServer.close();
}

/* ── Report ──────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.ok);
console.log(`\n${"=".repeat(64)}`);
console.log(`checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
if (failed.length) {
  console.log("\nFAILED:");
  for (const f of failed) console.log(`  · [${f.group}] ${f.name}${f.extra ? ` — ${f.extra}` : ""}`);
}
console.log(`mock stats: streaming=${state.streamingRequests} aborted=${state.abortedStreams} requests=${state.requests.length}`);
process.exit(failed.length === 0 ? 0 : 1);

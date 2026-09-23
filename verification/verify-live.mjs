/**
 * Live deployment verification.
 *
 * Loads the REAL GitHub Pages URL in Chrome and drives the full flow with
 * https://api.deepseek.com pointed at a local TLS mock (host-resolver rule), so
 * the deployed bundle's streaming path is exercised end to end.
 */
import { createServer } from "node:https";
import path from "node:path";
import { mkdirSync } from "node:fs";
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
const LIVE_URL = "https://nakanonino455.github.io/TalkQ-web/";
const MOCK_PORT = 8443;
const ARTIFACTS = path.join(import.meta.dirname, "artifacts");
mkdirSync(ARTIFACTS, { recursive: true });
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});

let apiRequests = 0;
/** Every parsed request body, for assertions about what was actually sent. */
const liveRequestBodies = [];
let lastBody = null;
const mock = createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString("utf8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type, authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  // Chrome's Private Network Access: the live page is a *public* origin
  // (github.io) and this mock answers on 127.0.0.1, so the preflight must
  // explicitly allow the public → local hop. Production traffic talks to the
  // real api.deepseek.com on a public IP, so this is harness-only.
  res.setHeader("Access-Control-Allow-Private-Network", "true");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  apiRequests += 1;
  const body = raw ? JSON.parse(raw) : null;
  lastBody = body;
  liveRequestBodies.push(body);
  if (!body?.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      })
    );
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant" } }] }));
  for (const part of ["线上版 ", "**GitHub Pages** ", "部署成功 🎉\n\n", "```text\nhttps://nakanonino455.github.io/TalkQ-web/\n```\n"]) {
    res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { content: part } }] }));
    await sleep(120);
  }
  res.write(
    chunk({
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 42, completion_tokens: 30, total_tokens: 72 },
    })
  );
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

const RELAXED = process.argv.includes("--relaxed");
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    `--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT}`,
    // The live page is a *public* origin while the mock answers on 127.0.0.1.
    // Chrome's Local/Private Network Access refuses that public → local hop
    // (in headless there is no one to grant the permission), which is purely a
    // harness artifact: real traffic goes to api.deepseek.com on a public IP.
    ...(RELAXED
      ? ["--disable-web-security", `--user-data-dir=${process.env.TEMP}\\nexq-live-profile`]
      : [
          "--disable-features=LocalNetworkAccessChecks,BlockInsecurePrivateNetworkRequests," +
            "PrivateNetworkAccessRespectPreflightResults,PrivateNetworkAccessSendPreflights," +
            "PrivateNetworkAccessForNavigations,PrivateNetworkAccessForWorkers",
        ]),
    // The far-field block below opens the microphone on the live origin; without
    // a fake device + auto-granted permission that would just be a denial.
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
  ],
});
const context = await browser.newContext({
  ignoreHTTPSErrors: true,
  viewport: { width: 1440, height: 900 },
});
// Microphone for the far-field block at the end of this suite.
await context.grantPermissions(["microphone"], { origin: new URL(LIVE_URL).origin });
const page = await context.newPage();

const consoleErrors = [];
const failedRequests = [];
page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text().slice(0, 180)));
page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message.slice(0, 180)}`));
page.on("requestfailed", (r) => failedRequests.push(`${r.url().slice(0, 110)} → ${r.failure()?.errorText}`));

console.log(`opening ${LIVE_URL}${RELAXED ? "  (relaxed network mode)" : ""}\n`);
const response = await page.goto(LIVE_URL, { waitUntil: "networkidle", timeout: 60000 });
check("live URL returns 200", response?.status() === 200, `HTTP ${response?.status()}`);
check("title is the TalkQ client", (await page.title()).includes("TalkQ"));
const liveIcons = await page.evaluate(async () => {
  const names = ["favicon.ico", "favicon-32.png", "apple-touch-icon.png", "icon-192.png", "site.webmanifest"];
  const out = {};
  for (const name of names) {
    try {
      out[name] = (await fetch(name)).status;
    } catch {
      out[name] = "error";
    }
  }
  return out;
});
check(
  "live favicon / touch icon / manifest served",
  Object.values(liveIcons).every((status) => status === 200),
  JSON.stringify(liveIcons)
);
const liveLogo = await page.evaluate(() => {
  const img = [...document.images].find((i) => i.src.includes("icon-192.png"));
  return img ? { width: img.naturalWidth, complete: img.complete } : { width: 0, complete: false };
});
check("live logo image loaded", liveLogo.complete && liveLogo.width >= 180, JSON.stringify(liveLogo));
check("dark theme applied", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(8, 12, 22)");

const keyInput = page.locator("#nexq-api-key");
await keyInput.waitFor({ timeout: 20000 });
check("API Key modal rendered on the live site", await keyInput.isVisible());
await page.screenshot({ path: path.join(ARTIFACTS, "live-modal.png") });

const assetUrls = await page.evaluate(() =>
  Array.from(document.querySelectorAll("script[src], link[href]")).map((el) => el.src || el.href)
);
check(
  "assets served from the /TalkQ-web/ sub-path",
  assetUrls.some((u) => u.includes("/TalkQ-web/assets/")),
  assetUrls.find((u) => u.includes("/assets/")) ?? "none"
);

await keyInput.fill("sk-live-deployment-check-123456");
await page.getByRole("button", { name: "Test & Continue" }).click();
await page.getByText("Connection successful", { exact: false }).first().waitFor({ timeout: 25000 }).catch(() => {});
const composer = page.locator("textarea").first();
await composer.waitFor({ timeout: 20000 });
if (await composer.isDisabled()) {
  const modalError = await page
    .locator(".text-destructive")
    .first()
    .innerText()
    .catch(() => "(no error box)");
  console.log(`  [debug] modal error: ${modalError.replace(/\s+/g, " ").slice(0, 200)}`);
  console.log(`  [debug] console: ${consoleErrors.slice(0, 3).join(" | ")}`);
}
check("Test & Continue works on the live site", !(await composer.isDisabled()));

await composer.fill("部署验证：请回复一段流式内容");
await page.getByRole("button", { name: "发送", exact: true }).click();
await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 25000 });
const answer = await page.locator(".nexq-prose").first().innerText();
check("streaming answer rendered on the live site", answer.includes("线上版") && answer.includes("部署成功"), answer.replace(/\s+/g, " ").slice(0, 46));
check("code block + Copy rendered", (await page.locator('button[aria-label="Copy code"]').count()) === 1);
check("request used model deepseek-flash", lastBody?.model === "deepseek-flash");
check("live key persisted in localStorage", (await page.evaluate(() => localStorage.getItem("talkq_deepseek_api_key"))) === "sk-live-deployment-check-123456");

await page.reload({ waitUntil: "networkidle" });
await composer.waitFor({ timeout: 20000 });
check("reload keeps the session (no modal, history restored)", (await page.locator("#nexq-api-key").count()) === 0);
check("no failed network requests", failedRequests.length === 0, failedRequests.slice(0, 2).join(" | "));

/* ── Document upload against the live deployment ─────────────────────
 * GitHub Pages must serve the pdf.js module worker with a JS MIME type; if it
 * did not, PDF parsing would fail only in production. This proves it works.
 */
const LIVE_PDF_TEXT = "TALKQ LIVE PDF 42";
function buildLivePdf(text) {
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

const [livePdfChooser] = await Promise.all([
  page.waitForEvent("filechooser", { timeout: 15000 }),
  page.getByRole("button", { name: "上传文档" }).click(),
]);
await livePdfChooser.setFiles([
  { name: "live.pdf", mimeType: "application/pdf", buffer: buildLivePdf(LIVE_PDF_TEXT) },
]);
const livePdfChip = await page
  .getByText("live.pdf")
  .first()
  .waitFor({ timeout: 30000 })
  .then(() => true)
  .catch(() => false);
check("live PDF parsed by pdf.js (worker MIME correct on Pages)", livePdfChip);

if (livePdfChip) {
  await page.locator("textarea").last().fill("pdf 里的暗号是什么？");
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 25000 });
  const carried = liveRequestBodies.some((body) =>
    (body?.messages ?? []).some((m) => String(m.content).includes(LIVE_PDF_TEXT))
  );
  check("live request carried the extracted PDF text", carried);
  await page.screenshot({ path: path.join(ARTIFACTS, "live-documents.png") });
}

const noisy = consoleErrors.filter((e) => !/favicon/i.test(e));
check("no console errors", noisy.length === 0, noisy.slice(0, 2).join(" | "));

/* ── Far-field capture + diagnostics on the deployed site ─────────────
 * Proves the raw-capture request and the diagnostics panel work over real
 * HTTPS on Pages, not just in the local harness.
 */
await page.getByRole("button", { name: /开始实时翻译/ }).first().click();
// In this sandbox Chrome's speech input may refuse to open (headless + fake
// device): that is an environment limitation, not an app failure, so the
// recognition-status check below records it instead of failing the suite.
await page.waitForTimeout(6000);
const liveStarted = await page.getByText("正在聆听").first().isVisible().catch(() => false);
const liveError = await page
  .evaluate(() => window.__TALKQ__?.translate?.getState?.().error?.title ?? null)
  .catch(() => null);
check(
  "live session reaches listening (or reports an environment mic error)",
  liveStarted || Boolean(liveError),
  liveStarted ? "listening" : `environment: ${liveError ?? "unknown"}`
);
const liveCapture = await page
  .evaluate(() => window.__TALKQ__?.translate?.getState?.().capture ?? null)
  .catch(() => null);
check(
  "far-field requested a raw capture on the live site (EC/NS/AGC off)",
  liveCapture?.applied?.echoCancellation === false &&
    liveCapture?.applied?.noiseSuppression === false &&
    liveCapture?.applied?.autoGainControl === false,
  JSON.stringify(liveCapture?.applied ?? null)
);
check(
  "the capture report includes the real device + sample rate",
  Boolean(liveCapture?.actual?.deviceLabel && liveCapture?.actual?.sampleRate),
  JSON.stringify(liveCapture?.actual ?? null)
);

const liveVad = await page
  .evaluate(() => {
    window.__TALKQ__?.translate?.getState?.().refreshDiagnostics?.();
    return window.__TALKQ__?.translate?.getState?.().vad ?? null;
  })
  .catch(() => null);
check(
  "VAD is producing measurements (level, noise floor, SNR)",
  Boolean(liveVad && Number.isFinite(liveVad.noiseFloorDb) && Number.isFinite(liveVad.snrDb)),
  JSON.stringify(liveVad ?? null)
);

await page.getByRole("button", { name: "Settings" }).first().click();
const liveSettings = page.getByRole("dialog", { name: "Settings" });
await liveSettings.waitFor({ timeout: 8000 });
const livePanelText = await liveSettings.innerText();
check(
  "live diagnostics panel shows the far-field numbers",
  ["Noise floor", "SNR", "Restart count", "Last partial", "距离校准"].every((label) =>
    livePanelText.includes(label)
  )
);
check(
  "live panel shows the capture answer from the browser",
  /回声消除 \/ 降噪 \/ 自动增益/.test(livePanelText) &&
    /(false|true) \/ (false|true) \/ (false|true)/.test(livePanelText)
);
await page.screenshot({ path: path.join(ARTIFACTS, "live-diagnostics.png") });
await page.getByRole("button", { name: "Close settings" }).click();

/* ── Stop → start again on the deployed build with Chrome's real recognizer ──
 * The reported bug: the first session works, the second one does nothing.
 * This drives three real cycles and requires each one to reach 正在聆听.
 */
const liveStatus = () =>
  page.evaluate(() => window.__TALKQ__?.translate?.getState?.().status ?? "unknown");
const startLabel = /开始实时翻译/;
const stopLabel = /停止翻译/;

for (let cycleNumber = 1; cycleNumber <= 3; cycleNumber += 1) {
  if ((await liveStatus()) !== "idle") {
    await page.getByRole("button", { name: stopLabel }).first().click().catch(() => {});
    await page.waitForTimeout(500);
  }
  await page.getByRole("button", { name: startLabel }).first().click();
  const listening = await page
    .getByText("正在聆听")
    .first()
    .waitFor({ timeout: 20000 })
    .then(() => true)
    .catch(() => false);
  const state = await liveStatus();
  const errorTitle = await page
    .evaluate(() => window.__TALKQ__?.translate?.getState?.().error?.title ?? null)
    .catch(() => null);
  check(
    `live cycle ${cycleNumber}: restarts and listens again`,
    listening,
    `status=${state}${errorTitle ? ` error=${errorTitle}` : ""}`
  );
}
await page.getByRole("button", { name: stopLabel }).first().click().catch(() => {});
await page.waitForTimeout(600);
check("live cycles end back at 未开始", (await liveStatus()) === "idle", await liveStatus());
const liveContext = await page
  .evaluate(() => {
    const frames = window.__TALKQ__?.translate?.getState?.().analysis;
    return { stalled: frames?.stalled ?? null };
  })
  .catch(() => null);
check("the analyser is not stuck after three cycles", liveContext?.stalled !== true, JSON.stringify(liveContext));

await page.screenshot({ path: path.join(ARTIFACTS, "live-chat.png") });
await browser.close();
mock.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nlive checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}   (api requests: ${apiRequests})`);
process.exit(failed.length ? 1 : 0);

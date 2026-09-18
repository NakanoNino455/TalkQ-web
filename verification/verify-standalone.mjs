/**
 * Verify the standalone single-file build works by double-click (file://):
 * modal → Test & Continue → streaming answer, with api.deepseek.com mocked.
 */
import { createServer } from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";
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
const FILE = path.join(PROJECT, "dist-standalone", "talkq.html");
const MOCK_PORT = 8443;
const results = [];
const check = (name, ok, extra = "") => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
};

const pems = await selfsigned.generate([{ name: "commonName", value: "api.deepseek.com" }], {
  days: 365,
  keySize: 2048,
});

let requests = 0;
let lastBody = null;
const mock = createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
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
  requests += 1;
  const body = raw ? JSON.parse(raw) : null;
  lastBody = body;
  if (!body?.stream) {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(
      JSON.stringify({
        model: "deepseek-flash",
        choices: [{ message: { role: "assistant", content: "Hello!" } }],
      })
    );
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  const chunk = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  res.write(chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { role: "assistant" } }] }));
  for (const part of ["文件版 ", "**流式** ", "正常。", "\n\n```js\nconsole.log(1)\n```\n"]) {
    res.write(
      chunk({ model: "deepseek-flash", choices: [{ index: 0, delta: { content: part } }] })
    );
    await sleep(90);
  }
  res.write(
    chunk({
      model: "deepseek-flash",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { completion_tokens: 12 },
    })
  );
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => mock.listen(MOCK_PORT, "127.0.0.1", r));

const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [`--host-resolver-rules=MAP api.deepseek.com 127.0.0.1:${MOCK_PORT}`],
});
const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 160)));
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));

const url = pathToFileURL(FILE).href;
console.log(`opening ${url}\n`);
await page.goto(url, { waitUntil: "load" });

check("app booted from file:// (no splash left)", (await page.locator("#talkq-splash").count()) === 0);
const keyInput = page.locator("#nexq-api-key");
await keyInput.waitFor({ timeout: 10000 });
check("API Key modal rendered inside the HTML file", await keyInput.isVisible());

await keyInput.fill("sk-standalone-test-123456");
await page.getByRole("button", { name: "Test & Continue" }).click();
await page.getByText("Connection successful", { exact: false }).first().waitFor({ timeout: 15000 }).catch(() => {});
const composer = page.locator("textarea").first();
await composer.waitFor({ timeout: 15000 });
check("key stored & chat unlocked", !(await composer.isDisabled()));
check(
  "localStorage key name is talkq_deepseek_api_key",
  (await page.evaluate(() => localStorage.getItem("talkq_deepseek_api_key"))) ===
    "sk-standalone-test-123456"
);

await composer.fill("测试文件版流式输出");
await page.getByRole("button", { name: "发送", exact: true }).click();
await page.getByRole("button", { name: "停止", exact: true }).waitFor({ state: "hidden", timeout: 20000 });
const answer = await page.locator(".nexq-prose").first().innerText();
check("streamed answer rendered", answer.includes("文件版") && answer.includes("流式"), answer.slice(0, 40));
check("code block with Copy rendered", (await page.locator('button[aria-label="Copy code"]').count()) === 1);
check("request reached api.deepseek.com mock", requests >= 2, `${requests} requests`);
check("model deepseek-flash", lastBody?.model === "deepseek-flash");
check("no console errors", errors.length === 0, errors.slice(0, 2).join(" | "));

await page.screenshot({ path: "artifacts/standalone-file.png" });
await browser.close();
mock.close();

const failed = results.filter((r) => !r.ok);
console.log(`\nstandalone checks: ${results.length}  passed: ${results.length - failed.length}  failed: ${failed.length}`);
process.exit(failed.length ? 1 : 0);

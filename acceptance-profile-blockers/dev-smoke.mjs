import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import { createWriteStream, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runtimeFixture } from "../tests/fixtures/runtimeConfig.ts";

const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH || "/tmp/c7rev2-clones/node_modules/playwright");
const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(web, "..");
const devOrigin = "http://127.0.0.1:27338";
const origin = "https://nucleagent-im-web.dev.ndaeweb.com";
mkdirSync(`${root}/runs`, { recursive: true });
mkdirSync(`${root}/shots`, { recursive: true });
const log = createWriteStream(`${root}/runs/dev-server.log`);
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "27338", "--strictPort"], { cwd: web });
server.stdout.pipe(log);
server.stderr.pipe(log);
const exited = once(server, "exit");
let browser;
try {
  let ready = false;
  for (let tries = 0; tries < 100; tries++) {
    if (server.exitCode !== null) throw new Error("dev server exited");
    if (await fetch(devOrigin).then(r => r.ok, () => false)) { ready = true; break; }
    await new Promise(done => setTimeout(done, 200));
  }
  assert.ok(ready, "dev server ready");
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 393]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.routeWebSocket("**/*", socket => socket.close());
    await page.route("**/*", async route => {
      const url = new URL(route.request().url());
      if (url.pathname.endsWith("/runtime-config.json"))
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(runtimeFixture()) });
      if (url.origin !== origin || url.pathname.includes("/api/"))
        return route.fulfill({ status: 401, contentType: "application/json", body: '{"code":401}', headers: { "access-control-allow-origin": "*" } });
      const response = await fetch(`${devOrigin}${url.pathname}${url.search}`);
      return route.fulfill({ status: response.status,
        contentType: response.headers.get("content-type") || "application/octet-stream",
        body: Buffer.from(await response.arrayBuffer()) });
    });
    await page.goto(origin);
    await page.locator('input[autocomplete="username"]').waitFor({ timeout: 10000 });
    assert.ok(await page.locator('input[autocomplete="current-password"]').isVisible());
    assert.deepEqual(errors, []);
    await page.screenshot({ path: `${root}/shots/dev-login-${width}.png` });
    console.log(`PASS local full App login render ${width}px, intercepted HTTPS origin, synthetic auth refusal, no credentials submitted`);
    await page.close();
  }
} finally {
  await browser?.close();
  if (server.exitCode === null) server.kill("SIGTERM");
  await exited;
  log.end();
}

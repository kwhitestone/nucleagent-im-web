import assert from "node:assert/strict";
import fs from "node:fs";
import { createServer as createHttp } from "node:http";
import { createRequire } from "node:module";
import { randomBytes } from "node:crypto";
import { createServer } from "vite";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const { WebSocketServer } = await import(process.env.WS_MODULE || "ws");
const require = createRequire(new URL("../package.json", import.meta.url));
const curve = require("curve25519-js");
const str = value => {
  const bytes = Buffer.from(value), size = Buffer.alloc(2);
  size.writeUInt16BE(bytes.length);
  return Buffer.concat([size, bytes]);
};
const sockets = new Set();
const stats = { connections: 0, closes: 0, handshakes: 0, sentMessages: 0 };
const http = createHttp();
const wss = new WebSocketServer({ server: http });
wss.on("connection", socket => {
  sockets.add(socket); stats.connections++;
  socket.on("close", () => { sockets.delete(socket); stats.closes++; });
  socket.on("message", raw => {
    const type = raw[0] >> 4;
    if (type === 7) { socket.send(Buffer.from([0x80])); return; }
    if (type === 3) stats.sentMessages++;
    if (type !== 1) return;
    const pair = curve.generateKeyPair(new Uint8Array(randomBytes(32)));
    const body = Buffer.concat([Buffer.alloc(8), Buffer.from([1]),
      str(Buffer.from(pair.public).toString("base64")), str("synthetic-iv-001")]);
    assert(body.length < 128);
    socket.send(Buffer.concat([Buffer.from([0x20, body.length]), body]));
    stats.handshakes++;
  });
});
await new Promise(resolve => http.listen(0, "127.0.0.1", resolve));
const port = http.address().port;
const vite = await createServer({ root: new URL("..", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0 },
  optimizeDeps: { entries: ["tests/browser/session-binding.html"] } });
let browser;
const errors = [];
try {
  await vite.listen();
  const url = `http://127.0.0.1:${vite.httpServer.address().port}/tests/browser/session-binding.html?socketPort=${port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.route("**/*", route => {
    const host = new URL(route.request().url()).hostname;
    return host === "127.0.0.1" ? route.continue() : route.abort();
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url);
  await page.waitForFunction(() => !!window.fixture);
  await page.locator('.login-panel input[type="password"]').waitFor({ state: "visible" });
  await page.evaluate(() => window.fixture.start());
  await page.waitForFunction(() => window.fixture.snapshot().connection === "connected");
  await page.evaluate(() => window.fixture.sweep());
  const initial = stats.connections;
  await page.evaluate(() => window.fixture.renew());
  assert.equal(stats.connections, initial, "renewal keeps the socket");
  for (const socket of sockets) socket.close(1000);
  await page.waitForFunction(() => window.fixture.snapshot().connection === "connected");
  await page.waitForFunction(() => window.fixture.calls.filter(c =>
    c.generation === 2 && c.path.endsWith("/messagesync") && c.status === 200).length > 0, null, { timeout: 15000 });
  assert(stats.connections > initial);
  const renewal = await page.evaluate(() => window.fixture.calls.filter(c =>
    c.generation === 2 && /conversation\/list|messagesync/.test(c.path)));
  assert(renewal.length >= 2 && renewal.every(c => c.fresh && c.status === 200));
  for (const status of [200, 401]) {
    await page.evaluate(() => {
      window.fixture.hold();
      window.pendingSweep = window.fixture.sweep();
    });
    await page.waitForFunction(() => window.fixture.snapshot().pending === 2);
    await page.evaluate(() => window.fixture.renew());
    const retired = await page.evaluate(() => window.fixture.snapshot());
    assert.equal(retired.aborted, 2);
    await page.evaluate(() => { window.fixture.unhold(); return window.fixture.sweep(); });
    await page.evaluate(status => window.fixture.release(status), status);
    await page.evaluate(() => window.pendingSweep);
    assert.equal((await page.evaluate(() => window.fixture.snapshot())).error, "");
  }
  await page.evaluate(() => { window.fixture.deny(true); return window.fixture.sweep(); });
  assert.match((await page.evaluate(() => window.fixture.snapshot())).error, /fixture_denied/);
  assert.equal((await page.evaluate(() => window.fixture.snapshot())).draft, "synthetic unsent draft");
  const result = { isolated: true, realApp: true, realSDK: true, fakeWS: true, syntheticBackend: true,
    ...stats, renewal, late200Fenced: true, late401Fenced: true, cancellationObserved: true,
    current401Rejected: true, loginVisible: true, draftPreserved: true, errors };
  assert.equal(stats.sentMessages, 0);
  assert.deepEqual(errors, []);
  const output = process.env.EVIDENCE_DIR;
  if (output) await page.screenshot({ path: `${output}/isolated-app.png` });
  await page.evaluate(() => window.fixture.stop());
  if (output) fs.writeFileSync(`${output}/browser-result.json`, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  await browser?.close();
  for (const socket of sockets) socket.terminate();
  await new Promise(resolve => wss.close(resolve));
  await new Promise(resolve => http.close(resolve));
  await vite.close();
}

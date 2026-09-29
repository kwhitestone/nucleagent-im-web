import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";
import ts from "typescript";

const temp = mkdtempSync(join(tmpdir(), "shell-origins-"));
symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temp, "node_modules"), "dir");
writeFileSync(join(temp, "package.json"), '{"type":"module"}');
const source = new URL("../src/vendor/prism-fusion-plugin-runtime/", import.meta.url);
for (const name of readdirSync(source).filter((name) => name.endsWith(".ts") && !name.endsWith(".d.ts"))) {
  const code = readFileSync(new URL(name, source), "utf8").replace(/\.ts(["'])/g, ".js$1");
  writeFileSync(join(temp, name.replace(/\.ts$/, ".js")), ts.transpileModule(code, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText);
}
after(() => rmSync(temp, { recursive: true, force: true }));
const { createRemoteChildChannel } = await import(pathToFileURL(join(temp, "remote-channel.js")).href);
const origins = ["https://shell.example", "http://tauri.localhost", "https://localhost"];
const id = "12345678-1234-1234-1234-123456789abc";
function setup(allowedHostOrigins?: string) {
  const replies: Array<{ data: unknown; origin: string }> = [];
  const parent = { postMessage(data: unknown, origin: string) { replies.push({ data, origin }); } };
  const channel = createRemoteChildChannel({ appId: "test", parent, hostOrigin: origins[0], allowedHostOrigins,
    messages: { toChild: ["auth"], fromChild: ["auth-required"] } });
  channel.ready();
  const event = (origin: string, type = "host:init") => ({ source: parent, origin,
    data: { protocol: "prism-fusion/remote", version: 1, appId: "test", instanceId: id, type } });
  return { channel, replies, parent, event };
}
for (const origin of origins) test(`binds exact replies to ${origin}`, () => {
  const { channel, replies, event } = setup(origins.join(","));
  assert.equal(channel.receive(event(origin)), true);
  assert.equal(channel.send("auth-required"), true);
  assert.deepEqual(replies.map((reply) => reply.origin), [origin, origin]);
  for (const other of origins.filter((entry) => entry !== origin)) {
    assert.equal(channel.receive(event(other)), false);
    assert.equal(channel.receive(event(other, "auth")), false);
  }
});
test("default remains the single configured shell", () => {
  const { channel, event } = setup();
  assert.equal(channel.receive(event(origins[1])), false);
  assert.equal(channel.receive(event(origins[0])), true);
});
test("rejects source, origin, protocol, app and instance forgery", () => {
  const { channel, event, replies } = setup(origins.join(","));
  assert.equal(channel.receive({ ...event(origins[0]), source: {} }), false);
  assert.equal(channel.receive(event("https://shell.example.evil")), false);
  for (const patch of [{ version: 2 }, { appId: "other" }, { protocol: "other" }, { instanceId: "bad" }]) {
    const input = event(origins[0]);
    assert.equal(channel.receive({ ...input, data: { ...input.data, ...patch } }), false);
  }
  assert.equal(replies.length, 0);
  assert.equal(channel.receive(event(origins[0])), true);
  const input = event(origins[0], "auth");
  assert.equal(channel.receive({ ...input, data: { ...input.data, instanceId: id.replace("abc", "def") } }), false);
  channel.dispose();
  assert.equal(channel.send("auth-required"), false);
});
test("malformed explicit list does not fall back or admit opaque origins", () => {
  const { channel, event } = setup("*,bad,file:///tmp,https://");
  assert.equal(channel.receive(event(origins[0])), false);
  assert.equal(channel.receive(event("null")), false);
});

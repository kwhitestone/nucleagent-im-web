import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { startRuntimeApp } from "../src/bootstrap.ts";

test("host:init during config load is kept without payload and replayed after mount", async t => {
  const target = new EventTarget() as Window;
  const parent = new MessageChannel().port1;
  t.after(() => parent.close());
  Object.defineProperty(target, "parent", { value: parent });
  let release!: () => void;
  const config = new Promise<void>(resolve => { release = resolve; });
  const delivered: MessageEvent[] = [];
  const send = (data: object) => target.dispatchEvent(new MessageEvent("message", {
    data, source: parent, origin: "https://shell.example.test",
  }));
  const pending = startRuntimeApp(() => config, async () => {
    target.addEventListener("message", event => delivered.push(event as MessageEvent));
  }, target);
  send({ protocol: "prism-fusion/remote", type: "auth", version: 1, appId: "im", instanceId: "fixture-instance-1234", payload: { token: "do-not-buffer" } });
  send({ protocol: "prism-fusion/remote", type: "host:init", version: 1, appId: "core", instanceId: "fixture-instance-1234" });
  send({ protocol: "prism-fusion/remote", type: "host:init", version: 1,
    appId: "im", instanceId: "fixture-instance-1234", payload: { token: "do-not-buffer" } });
  assert.equal(delivered.length, 0);
  release();
  await pending;
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].origin, "https://shell.example.test");
  assert.equal(delivered[0].source, parent);
  assert.equal(delivered[0].data.instanceId, "fixture-instance-1234");
  assert.doesNotMatch(JSON.stringify(delivered[0].data), /do-not-buffer/);
});

test("agentia:embed-init during config load is kept without extra fields and replayed after mount", async t => {
  const target = new EventTarget() as Window;
  const parent = new MessageChannel().port1;
  t.after(() => parent.close());
  Object.defineProperty(target, "parent", { value: parent });
  let release!: () => void;
  const config = new Promise<void>(resolve => { release = resolve; });
  const delivered: MessageEvent[] = [];
  const send = (data: object, source: unknown = parent) => target.dispatchEvent(new MessageEvent("message", {
    data, source: source as MessagePort, origin: "https://agentia.example.test",
  }));
  const pending = startRuntimeApp(() => config, async () => {
    target.addEventListener("message", event => delivered.push(event as MessageEvent));
  }, target);
  send({ type: "agentia:embed-credential", payload: { conversationId: "c1", ucToken: "do-not-buffer" } });
  send({ type: "agentia:embed-init", payload: { conversationId: "x".repeat(201) } });
  send({ type: "agentia:embed-init", payload: { conversationId: "c1", ucToken: "do-not-buffer" } });
  release();
  await pending;
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].data, { type: "agentia:embed-init", payload: { conversationId: "c1" } });
  assert.equal(delivered[0].origin, "https://agentia.example.test");
});

test("failed config never mounts, replays or retains a listener", async () => {
  let added = 0, removed = 0, mounted = 0, dispatched = 0;
  const target = {
    addEventListener() { added++; }, removeEventListener() { removed++; },
    dispatchEvent() { dispatched++; },
  } as unknown as Window;
  await assert.rejects(startRuntimeApp(async () => { throw Error("invalid config"); },
    async () => { mounted++; }, target));
  assert.deepEqual([added, removed, mounted, dispatched], [1, 1, 0, 0]);
});

test("the page boots through runtime config, and no source reads build-time endpoints", () => {
  assert.match(readFileSync(new URL("../index.html", import.meta.url), "utf8"), /src="\/src\/boot\.ts"/);
  for (const path of ["src/api.ts", "src/shell.ts", "src/accountPopover.ts", "src/boot.ts", "Dockerfile"]) {
    const text = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /import\.meta\.env/, path);
    assert.doesNotMatch(text, /https?:\/\/(?:localhost|127\.0\.0\.1):266\d\d/, path);
  }
});

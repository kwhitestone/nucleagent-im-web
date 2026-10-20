import assert from "node:assert/strict";
import test from "node:test";
import { embedHostMessage, installEmbedHost } from "../src/embedHost.ts";
import { runtimeFixture } from "./fixtures/runtimeConfig.ts";

const host = "https://agentia.dev.ndaeweb.com";
const auth = runtimeFixture().VITE_AUTH_BASE;
const ucToken = "uc-secret-canary";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function framed() {
  const sent: Array<{ message: any; targetOrigin: string }> = [];
  const listeners: Array<(event: any) => void> = [];
  const parent = { postMessage: (message: unknown, targetOrigin: string) => sent.push({ message, targetOrigin }) };
  const window = {
    parent,
    addEventListener: (_: string, handler: (event: any) => void) => listeners.push(handler),
    removeEventListener: (_: string, handler: (event: any) => void) => listeners.splice(listeners.indexOf(handler), 1),
  };
  const deliver = (type: string, payload: unknown, event: Record<string, unknown> = {}) =>
    listeners.forEach((handler) => handler({ source: parent, origin: host, data: { type, payload }, ...event }));
  return { window, parent, sent, deliver, listenerCount: () => listeners.length };
}

function harness(t: any, configured = host, response: () => Response = () =>
  new Response(JSON.stringify({ accessToken: "nuc-jwt" }), { status: 200 })) {
  const frame = framed();
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const originalWindow = (globalThis as any).window;
  const originalFetch = globalThis.fetch;
  (globalThis as any).window = frame.window;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return response();
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = originalWindow;
  });
  const events: string[] = [];
  const dispose = installEmbedHost({
    onInit: () => events.push("init"),
    onCredential: (token) => events.push(`token:${token}`),
    onRevoke: () => { events.push("revoke"); return "nuc-jwt"; },
  }, configured);
  return { frame, calls, events, dispose };
}

test("host messages are shape-checked; malformed ones are dropped", () => {
  assert.deepEqual(embedHostMessage({ type: "agentia:embed-init", payload: { conversationId: " c1 " } }),
    { kind: "init", conversationId: "c1" });
  assert.equal(embedHostMessage({ type: "agentia:embed-init", payload: { conversationId: "x".repeat(201) } }), null);
  assert.equal(embedHostMessage({ type: "agentia:embed-credential", payload: { conversationId: "c1", ucToken: "" } }), null);
  assert.equal(embedHostMessage({ type: "agentia:embed-other", payload: { conversationId: "c1" } }), null);
  assert.equal(embedHostMessage("agentia:embed-init"), null);
});

test("handshake: init → ready, then the credential is exchanged and acked", async (t) => {
  const { frame, calls, events } = harness(t);
  frame.deliver("agentia:embed-init", { conversationId: "c1" });
  assert.deepEqual(frame.sent, [{ message: { type: "nucleagent:ready", payload: { conversationId: "c1" } }, targetOrigin: host }]);
  frame.deliver("agentia:embed-credential", { conversationId: "c1", ucToken });
  await tick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${auth}/api/v1/addons/auth/portal/credential`);
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(calls[0].init.body, JSON.stringify({ credential: ucToken }));
  assert.deepEqual(events, ["init", "token:nuc-jwt"]);
  assert.deepEqual(frame.sent.at(-1), {
    message: { type: "nucleagent:credential-ack", payload: { conversationId: "c1", status: "ok" } }, targetOrigin: host,
  });
});

test("a rejected exchange acks rejected and never leaks the credential", async (t) => {
  const { frame, events } = harness(t, host, () => new Response(`{"echo":"${ucToken}"}`, { status: 401 }));
  frame.deliver("agentia:embed-init", { conversationId: "c1" });
  frame.deliver("agentia:embed-credential", { conversationId: "c1", ucToken });
  await tick();
  assert.deepEqual(events, ["init", "token:null"]);
  assert.equal(frame.sent.at(-1)?.message.payload.status, "rejected");
  assert.doesNotMatch(JSON.stringify(frame.sent), /secret-canary/);
});

test("a forged host (origin, source) or an unconfigured list gets no ready and no exchange", async (t) => {
  const { frame, calls, events } = harness(t);
  for (const event of [{ origin: "https://evil.example.test" }, { origin: "https://agentia.dev.ndaeweb.com.evil.test" }, { source: {} }]) {
    frame.deliver("agentia:embed-init", { conversationId: "c1" }, event);
    frame.deliver("agentia:embed-credential", { conversationId: "c1", ucToken }, event);
  }
  await tick();
  assert.deepEqual([frame.sent, calls, events], [[], [], []]);

  const off = harness(t, "");
  off.frame.deliver("agentia:embed-init", { conversationId: "c1" });
  assert.equal(off.frame.listenerCount(), 0);
  assert.deepEqual(off.frame.sent, []);
});

test("no credential is used before ready, nor for another conversation", async (t) => {
  const { frame, calls } = harness(t);
  frame.deliver("agentia:embed-credential", { conversationId: "c1", ucToken });
  frame.deliver("agentia:embed-init", { conversationId: "c1" });
  frame.deliver("agentia:embed-credential", { conversationId: "c2", ucToken });
  frame.deliver("agentia:embed-revoke", { conversationId: "c2" });
  await tick();
  assert.equal(calls.length, 0);
  assert.equal(frame.sent.length, 1);
});

test("revoke drops the session for the handshaken conversation only and revokes it server-side", (t) => {
  const { frame, events, calls, dispose } = harness(t);
  frame.deliver("agentia:embed-revoke", { conversationId: "c1" });
  frame.deliver("agentia:embed-init", { conversationId: "c1" });
  frame.deliver("agentia:embed-revoke", { conversationId: "c1" });
  assert.deepEqual(events, ["init", "revoke"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${auth}/api/v1/addons/auth/logout`);
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, "nuc-jwt");
  dispose();
  assert.equal(frame.listenerCount(), 0);
});

test("standalone installs nothing", (t) => {
  const self: any = { addEventListener: () => assert.fail("no listener standalone") };
  self.parent = self;
  const original = (globalThis as any).window;
  (globalThis as any).window = self;
  t.after(() => { (globalThis as any).window = original; });
  installEmbedHost({ onInit: assert.fail, onCredential: assert.fail, onRevoke: assert.fail }, host)();
});

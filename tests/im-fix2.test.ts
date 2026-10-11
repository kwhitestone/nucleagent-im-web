import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test, { after, mock } from "node:test";
import ts from "typescript";
import { parse } from "@vue/compiler-sfc";
import { Channel, Conversation, Message, MessageText, WKSDK, type SendackPacket } from "wukongimjssdk";
import * as im from "../src/im.ts";

// Same handler integration harness as conversationHistory.test.ts: real App code, fake I/O.
const app = parse(readFileSync("src/App.vue", "utf8"));
const source = ts.createSourceFile("App.ts", app.descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
const names = new Set(["sendMessage", "syncConversations", "loadMoreConversationPage",
  "mergeConversationPage", "upsertConversation", "onVisible"]);
const code = ts.transpileModule(source.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && names.has(node.name?.text ?? "")
).map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const row = (id: string) => ({ channel_id: id, channel_type: 2, active_at: 1 });
const ids = (list: Conversation[]) => Array.from(list, (c) => c.channel.channelID);
let serial = 0;
after(() => clearInterval((WKSDK.shared().receiptManager as any).timer));

function harness(visibleAfter = 3791, fail = false) {
  mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
  const session = { uid: `fix2-${++serial}`, token: "fixture", jwt: "fixture", wsAddr: "ws://fixture" };
  const calls: Array<{ at: number; cursor: string }> = [];
  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  const originalFetch = globalThis.fetch;
  const chat = WKSDK.shared().chatManager;
  const originalSend = chat.send;
  globalThis.fetch = async (_input, init) => {
    const cursor = JSON.parse(String(init?.body || "{}")).cursor || "";
    calls.push({ at: Date.now(), cursor });
    if (fail && Date.now() >= 3000) throw new Error("fixture list unavailable");
    return new Response(JSON.stringify(cursor
      ? { conversations: [row("page2")], done: true }
      : { conversations: [...(Date.now() >= visibleAfter ? [row("new")] : []), row("old")],
        next_cursor: "next", done: false }));
  };
  im.configureSDK(session);
  WKSDK.shared().conversationManager.conversations = [];
  const state: Record<string, any> = {
    ...im, WKSDK, console: { warn: (...args: unknown[]) => warnings.push(args) },
    session: { value: session }, connection: { value: "connected" },
    activeChannel: { value: new Channel("new", 2) }, draft: { value: "hello" },
    conversations: { value: [] }, messages: { value: [] }, mentionedAgentUids: { value: [] },
    loginError: { value: "" }, sending: { value: false }, recipientDisabled: { value: false },
    hasMoreConversations: { value: true }, loadingConversations: { value: false },
    viewGeneration: 0, document: { visibilityState: "visible" },
    batch: { refreshHidden() {} }, syncGroups() {}, refreshActiveHistory() {},
    channelKey: (c: Channel) => `${c.channelType}:${c.channelID}`,
    buildOutgoingText: (text: string) => new MessageText(text),
    sendToEnabledRecipient: async (_c: unknown, _s: unknown, _current: unknown, send: () => Promise<void>) => {
      await send(); return "sent";
    },
    mergeMessages: (_old: unknown, next: unknown) => next,
    scrollToBottom() {}, t: (s: string) => s,
  };
  const context = createContext(state);
  runInContext(code, context);
  chat.send = async (_content, channel) => {
    const message = Object.assign(new Message(), { clientSeq: ++serial, channel });
    setTimeout(() => chat.notifyMessageStatusListeners({ clientSeq: message.clientSeq } as SendackPacket), 3000);
    return message;
  };
  return { state, calls, warnings, session,
    run: (expression: string) => runInContext(expression, context),
    async tick(ms: number) { mock.timers.tick(ms); await flush(); },
    restore() { globalThis.fetch = originalFetch; chat.send = originalSend; console.warn = originalWarn; mock.timers.reset(); },
  };
}

test("P1 integration: 3s uplink, ACK before list projection, close on draft clear; fresh list has row within 20s", async () => {
  const h = harness();
  try {
    await h.run("syncConversations()");
    let closed = false;
    const sending = h.run("sendMessage()").then(async () => {
      assert.equal(h.state.draft.value, "");
      closed = true;
      // Close at the exact completion signal, even on the broken implementation.
      WKSDK.shared().conversationManager.conversations = [];
      h.state.conversations.value = [];
      await h.run("syncConversations()");
    });
    await flush();
    await h.tick(3000);
    await h.tick(500);
    await h.tick(1500);
    await sending;
    assert.equal(closed, true);
    await h.tick(20000);
    assert.ok(ids(h.state.conversations.value).includes("new"), "P1 fresh list row, no visibility event");
    assert.equal(h.state.loginError.value, "");
  } finally { h.restore(); }
});

test("bounded reconciliation backs off 500/1500ms, merges without losing pages, then R1 shares one sweep", async () => {
  const h = harness();
  try {
    await h.run("syncConversations()");
    await h.run("loadMoreConversationPage()");
    const sending = h.run("sendMessage()");
    await flush();
    await h.tick(3000);
    await h.tick(499);
    assert.deepEqual(h.calls.map((c) => c.at), [0, 0, 3000]);
    await h.tick(1);
    await h.tick(1499);
    assert.deepEqual(h.calls.map((c) => c.at), [0, 0, 3000, 3500]);
    await h.tick(1);
    await sending;
    assert.deepEqual(h.calls.map((c) => c.at), [0, 0, 3000, 3500, 5000]);
    assert.deepEqual(new Set(ids(h.state.conversations.value)), new Set(["old", "page2", "new"]));
    assert.deepEqual(new Set(ids(WKSDK.shared().conversationManager.conversations)), new Set(["old", "page2", "new"]));
    const before = h.calls.length;
    h.run("onVisible(); onVisible(); onVisible()");
    await flush();
    await h.tick(5000);
    assert.equal(h.calls.length - before, 2, "R1: three events cause only the two already loaded pages");
    assert.equal(h.state.conversations.value.length, 3);
  } finally { h.restore(); }
});

test("read failures stop after three attempts, keep ACK success, and a later send can recover", async () => {
  const h = harness(Infinity, true);
  try {
    await h.run("syncConversations()");
    const sending = h.run("sendMessage()");
    await flush();
    await h.tick(3000);
    await h.tick(500);
    await h.tick(1500);
    await sending;
    await h.tick(20000);
    assert.equal(h.calls.length, 4, "initial page plus exactly three bounded reads, no storm");
    assert.equal(h.state.draft.value, "", "a read failure is not a send failure");
    assert.equal(h.state.loginError.value, "");
    assert.ok(h.warnings.length > 0, "read failures are logged");
    h.state.draft.value = "retry";
    const again = h.run("sendMessage()");
    await flush();
    await h.tick(3000);
    await h.tick(500);
    await h.tick(1500);
    await again;
    assert.equal(h.calls.length, 7, "no permanent circuit breaker");
  } finally { h.restore(); }
});

test("an ACK for a server-listed conversation needs no extra reads", async () => {
  const h = harness(0);
  try {
    await h.run("syncConversations()");
    const sending = h.run("sendMessage()");
    await flush();
    await h.tick(3000);
    await sending;
    assert.equal(h.calls.length, 1);
    assert.equal(h.state.draft.value, "");
  } finally { h.restore(); }
});

test("concurrent reconciliation of the same ACK shares all attempts, not one loop per trigger", async () => {
  const h = harness(Infinity);
  try {
    await h.run("syncConversations()");
    const channel = h.state.activeChannel.value;
    const pending = [1, 2, 3].map(() => im.reconcileAckedConversation(channel, h.session));
    await flush();
    assert.equal(h.calls.length, 2, "one head probe for three callers");
    await h.tick(500);
    await h.tick(1500);
    await Promise.all(pending);
    assert.equal(h.calls.length, 4, "one initial sync plus one bounded loop");
    await h.tick(20000);
    assert.equal(h.calls.length, 4, "exhaustion leaves no polling timer");
  } finally { h.restore(); }
});

test("account change during backoff cancels the old gap without merging its row or further reads", async () => {
  const h = harness();
  try {
    await h.run("syncConversations()");
    const sending = h.run("sendMessage()");
    await flush();
    await h.tick(3000);
    const replacement = { ...h.session, uid: "replacement" };
    im.configureSDK(replacement);
    h.state.session.value = replacement;
    await h.tick(500);
    await sending;
    assert.equal(h.calls.length, 2);
    assert.deepEqual(ids(h.state.conversations.value), ["old"]);
    assert.equal(h.state.draft.value, "hello", "old completion cannot clear another session's draft");
  } finally { h.restore(); }
});

test("a hanging reconciliation fetch is aborted, then retries and releases the composer", async () => {
  const h = harness();
  const originalTimeout = AbortSignal.timeout;
  const signals: AbortSignal[] = [];
  AbortSignal.timeout = (ms: number) => {
    assert.equal(ms, 1500);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  };
  try {
    await h.run("syncConversations()");
    globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
      const signal = init?.signal!;
      signals.push(signal);
      signal.addEventListener("abort", () => reject(new Error("fixture timeout")), { once: true });
    });
    const sending = h.run("sendMessage()");
    await flush();
    await h.tick(3000);
    await h.tick(1500);
    await h.tick(500);
    await h.tick(1500);
    await h.tick(1500);
    await h.tick(1500);
    await sending;
    assert.equal(signals.length, 3);
    assert.ok(signals.every((s) => s.aborted));
    assert.equal(h.state.draft.value, "");
    assert.equal(h.state.loginError.value, "");
  } finally { AbortSignal.timeout = originalTimeout; h.restore(); }
});

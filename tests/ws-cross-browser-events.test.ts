// MUYU-161 D12 behavioural red/green, driven ONLY by external browser events that exist in both
// the pre-fix (f0154cb) and the fixed App: `window` "online" and `document` "visibilitychange".
// The App's own listener registrations are executed (the lines from `window.addEventListener("online",
// remintWhenOnline)` through the following `document.addEventListener` lines); every referenced
// handler is either the App's real code or a stub that exists in both versions. No App function is
// called directly by the test, so the old version fails by BEHAVIOUR (stays yielded), not by a
// missing name.
// Real trace replayed: PRE acc-pre-r33-fgn 2026-10-27 15:26–15:34Z — a same-account rival in another
// browser takes the connection; this tab yields, spends its probes while the rival is still there,
// the rival leaves, then the network drops 60 s and returns / the tab becomes visible again.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ref } from "vue";
import { renewsSameUser } from "../src/api.ts";
import * as history from "../src/history.ts";

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const section = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end));
const listenerStart = 'window.addEventListener("online", remintWhenOnline);';
// From the remintWhenOnline registration up to the first line that is not an add*Listener call.
const tail = app.slice(app.indexOf(listenerStart)).split("\n");
const regs: string[] = [];
for (const line of tail) { if (/^(window|document)\.addEventListener\(/.test(line.trim()) || line.trim().startsWith("//")) regs.push(line); else break; }
const source = ts.transpileModule([
  section("const remint = remintGuard();", "const conversationListener:"),
  section("async function adoptShellSession(", "async function restoreSession("),
  section("async function remintConnectToken(", "// R5:"),
  section("function teardownSession(", "// The AccountPopover"),
  "function rereadAgentDirectory() {}",
  ...regs,
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

const jwt = (iat: number, userId = 11) => `h.${Buffer.from(JSON.stringify({ userId, iat })).toString("base64url")}.s`;
const envelope = (accessToken: string, uid = "11") => ({ uid, jwt: accessToken, token: "synthetic-im", wsAddr: "ws://fixture" });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
const CONNECTED = 1, CONNECT_FAIL = 3, DISCONNECT = 0;

function eventTarget() {
  const listeners = new Map<string, Array<(e: unknown) => void>>();
  return {
    addEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, [...(listeners.get(type) || []), fn]); },
    removeEventListener: (type: string, fn: (e: unknown) => void) => { listeners.set(type, (listeners.get(type) || []).filter((x) => x !== fn)); },
    dispatch: (type: string) => { for (const fn of listeners.get(type) || []) fn({ type }); },
  };
}

function fixture() {
  const pending: { resolve: (v: ReturnType<typeof envelope>) => void; reject: (e: Error) => void }[] = [];
  const timers: Array<{ fn: () => void; ms: number; due: number; cleared?: boolean; fired?: boolean }> = [];
  const win = eventTarget();
  const doc = Object.assign(eventTarget(), { visibilityState: "visible" });
  let online = true;
  const noop = () => {};
  const ctx: Record<string, any> = {
    session: ref(envelope(jwt(1))), connection: ref("connected"), draft: ref("unsent draft"),
    activeChannel: ref({ channelID: "kept-channel" }), shellAuthGeneration: 1, renewsSameUser,
    ...history, ref, clock: 1_000_000, crypto: { randomUUID: () => "tab-under-test" },
    Math: Object.assign(Object.create(Math), { random: () => 0.5 }),
    performance: { now: () => ctx.clock }, Date: { now: () => ctx.clock },
    BroadcastChannel: undefined, window: win, document: doc,
    navigator: { get onLine() { return online; } },
    ConnectStatus: { Connected: 1, Connecting: 2, ConnectFail: 3, Disconnect: 0 },
    imSession: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    WKSDK: { shared: () => ({ disconnect: noop, connect: noop, conversationManager: {} }) },
    configureSDK: () => ({ connect: noop }), startAgentStream: noop, startSession: noop,
    syncConversations: noop, syncGroups: noop, refreshActiveHistory: noop, openPendingConversation: noop,
    refreshAgentPresentation: noop, readAgentCapabilities: noop, batch: { refreshHidden: noop, reset: noop },
    agentDirectory: { clear: noop }, removeListeners: noop, resetNames: noop,
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, due: ctx.clock + ms }; timers.push(t); return t; },
    clearTimeout: (t?: { cleared?: boolean }) => { if (t) t.cleared = true; },
    viewGeneration: 0, streamAbort: undefined, directoryEpoch: 0, directoryReading: undefined, directoryTimer: undefined,
    pendingConversationTarget: null, shellBridge: { reportAuthRequired: noop },
    shellSignedOut: () => { ctx.session.value = undefined; }, clearCachedContacts: noop, clearCachedProfile: noop, signInViaShell: noop,
    onKeydown: noop, onVisible: noop,
  };
  for (const n of ["managementOpen", "canManageAgents", "conversations", "groups", "directoryAgents", "directoryError",
    "knownContacts", "menu", "listMenuOpen", "hiddenOpen", "searchOpen", "profileName", "profileAvatar", "profileRoles",
    "dialOpen", "dialOpenId", "dialError", "activeGroupMembers", "messages", "liveResponses", "password", "loginError", "loggingIn"]) ctx[n] = ref();
  runInNewContext(source, ctx);
  const status = (s: number, reason = 2) => runInNewContext(`connectStatusListener(${s}, ${reason})`, ctx);
  /** Run every armed timer due within `ms` (in due order), resolving each mint the server answers. */
  const advance = async (ms: number, server: "rival-holds" | "free") => {
    const end = ctx.clock + ms;
    for (let i = 0; i < 500; i++) {
      const t = timers.filter((x) => !x.cleared && !x.fired && x.due <= end).sort((a, b) => a.due - b.due)[0];
      if (!t) break;
      ctx.clock = Math.max(ctx.clock, t.due); t.fired = true; t.fn();
      const p = pending.at(-1) as any;
      if (p && !p.done) {
        p.done = true; p.resolve(envelope(jwt(1))); await flush();
        status(CONNECTED);
        if (server === "rival-holds") { ctx.clock += 2_000; status(DISCONNECT, 0); ctx.clock += 3_000; status(CONNECT_FAIL); }
      }
    }
    ctx.clock = Math.max(ctx.clock, end);
  };
  return { ctx, status, advance, win, doc, pending, setOnline: (v: boolean) => { online = v; } };
}

/** The PRE trace up to the point of failure: yielded, budget spent while the rival held on, rival gone. */
async function preTrace() {
  const f = fixture();
  for (let i = 0; i < 2; i++) { // two quick displacement losses -> yield
    f.status(CONNECTED); f.ctx.clock += 2_000; f.status(DISCONNECT, 0); f.ctx.clock += 3_000; f.status(CONNECT_FAIL);
    (f.pending.at(-1) as any)?.resolve(envelope(jwt(1))); await flush();
  }
  assert.equal(f.ctx.connection.value, "conflict");
  await f.advance(20 * 60_000, "rival-holds"); // probes run while the rival is still there
  assert.equal(f.ctx.connection.value, "conflict");
  const mintsBefore = f.pending.length;
  await f.advance(20 * 60_000, "free"); // the rival has left; nothing happens by itself any more
  assert.equal(f.pending.length, mintsBefore, "budget spent: idle alone does not probe");
  return f;
}

test("D12 replay (external events only): network drop 60 s and back -> the yielded tab recovers", async () => {
  const f = await preTrace();
  f.setOnline(false); f.win.dispatch("offline"); f.ctx.clock += 60_000;
  f.setOnline(true); f.win.dispatch("online");
  await f.advance(10 * 60_000, "free");
  assert.equal(f.ctx.connection.value, "connected", "recovered after the network came back (PRE r33 stayed 冲突 for 120 s)");
  assert.equal(f.ctx.draft.value, "unsent draft");
});

test("D12 replay (external events only): tab hidden then visible again -> the yielded tab recovers", async () => {
  const f = await preTrace();
  f.doc.visibilityState = "hidden"; f.doc.dispatch("visibilitychange");
  f.doc.visibilityState = "visible"; f.doc.dispatch("visibilitychange");
  await f.advance(10 * 60_000, "free");
  assert.equal(f.ctx.connection.value, "connected");
});

test("D12 replay (external events only): repeated visibility flips stay bounded while the rival keeps winning", async () => {
  const f = await preTrace();
  const before = f.pending.length;
  for (let i = 0; i < 20; i++) { // 20 flips within 10 s
    f.doc.visibilityState = "hidden"; f.doc.dispatch("visibilitychange");
    f.doc.visibilityState = "visible"; f.doc.dispatch("visibilitychange");
    f.ctx.clock += 500;
  }
  await f.advance(30 * 60_000, "rival-holds");
  assert.ok(f.pending.length - before <= history.PROBE_DELAYS_MS.length, `bounded: ${f.pending.length - before}`);
  assert.equal(f.ctx.connection.value, "conflict");
});


// D13 — the real PRE xbrowser trace of 2026-10-27 21:35–22:01Z: the network came back while the
// round was STILL waiting out its last (300 s+) delay (4 of 5 probes used): nothing happened for 600 s.
async function preTraceLongDelay() {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.status(CONNECTED); f.ctx.clock += 2_000; f.status(DISCONNECT, 0); f.ctx.clock += 3_000; f.status(CONNECT_FAIL);
    (f.pending.at(-1) as any)?.resolve(envelope(jwt(1))); await flush();
  }
  // Run the rival-holds phase only until 4 probes are used (read the real counter).
  for (let i = 0; i < 60 && runInNewContext("probesUsed", f.ctx) < history.PROBE_DELAYS_MS.length - 1; i++) {
    await f.advance(30_000, "rival-holds");
  }
  assert.equal(runInNewContext("probesUsed", f.ctx), history.PROBE_DELAYS_MS.length - 1, "budget not spent: in the long tail");
  assert.equal(f.ctx.connection.value, "conflict");
  return f;
}

test("D13 replay (external events only): network back during the long tail -> recovers within ~10 s", async () => {
  const f = await preTraceLongDelay();
  f.setOnline(false); f.win.dispatch("offline"); f.ctx.clock += 60_000;
  f.setOnline(true); f.win.dispatch("online");
  await f.advance(15_000, "free");
  assert.equal(f.ctx.connection.value, "connected", "pulled forward; PRE xbrowser 21:49Z stayed 冲突 for 600 s");
  assert.equal(f.ctx.draft.value, "unsent draft");
});

test("D13 replay (external events only): tab visible again during the long tail -> recovers within ~10 s", async () => {
  const f = await preTraceLongDelay();
  f.doc.visibilityState = "hidden"; f.doc.dispatch("visibilitychange");
  f.doc.visibilityState = "visible"; f.doc.dispatch("visibilitychange");
  await f.advance(15_000, "free");
  assert.equal(f.ctx.connection.value, "connected");
});

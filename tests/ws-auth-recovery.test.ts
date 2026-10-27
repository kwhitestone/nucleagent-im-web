import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ref } from "vue";
import { renewsSameUser } from "../src/api.ts";
import {
  CONFLICT_WINDOW_MS, connectionConflict, isPeerReport, PEER_FRESH_MS, PEER_HEARTBEAT_MS, PEER_QUERY_WAIT_MS, peerLiveness,
  PROBE_DELAYS_MS, PROBE_JITTER, remintGuard,
} from "../src/history.ts";

const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
const section = (start: string, end: string) => app.slice(app.indexOf(start), app.indexOf(end));
const source = ts.transpileModule([
  section("const remint = remintGuard();", "const conversationListener:"),
  section("async function adoptShellSession(", "async function restoreSession("),
  section("async function remintConnectToken(", "// R5:"),
  section("function teardownSession(", "// The AccountPopover"),
].join("\n"), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const jwt = (iat: number, userId = 11) =>
  `h.${Buffer.from(JSON.stringify({ userId, iat })).toString("base64url")}.s`;
const envelope = (accessToken: string, uid = "11") =>
  ({ uid, jwt: accessToken, token: "synthetic-im", wsAddr: "ws://fixture" });
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

let tabSeq = 0;
function fixture(state = "connected", opts: { channel?: unknown; random?: () => number } = {}) {
  const calls: string[] = [];
  const pending: { resolve: (value: ReturnType<typeof envelope>) => void; reject: (error: Error) => void }[] = [];
  const noop = () => {};
  const context: Record<string, any> = {
    session: ref(envelope(jwt(1))),
    connection: ref(state),
    draft: ref("unsent draft"),
    activeChannel: ref({ channelID: "kept-channel" }),
    shellAuthGeneration: 1,
    renewsSameUser,
    remintGuard,
    ref, connectionConflict, CONFLICT_WINDOW_MS, isPeerReport, PEER_FRESH_MS, PEER_HEARTBEAT_MS, PEER_QUERY_WAIT_MS, peerLiveness,
    PROBE_DELAYS_MS, PROBE_JITTER,
    BroadcastChannel: opts.channel,
    window: { addEventListener() {}, removeEventListener() {} },
    document: { visibilityState: "visible", addEventListener() {}, removeEventListener() {} },
    lastRearmAt: -Infinity,
    Math: Object.assign(Object.create(Math), { random: opts.random ?? (() => 0.5) }),
    crypto: { randomUUID: () => `tab-${++tabSeq}` },
    clock: 1_000_000,
    performance: { now: () => context.clock },
    ConnectStatus: { Connected: 1, Connecting: 2, ConnectFail: 3, Disconnect: 0 },
    imSession: ({ accessToken }: { accessToken: string }) => {
      calls.push(`mint:${accessToken}`);
      return new Promise<ReturnType<typeof envelope>>((resolve, reject) => pending.push({ resolve, reject }));
    },
    WKSDK: { shared: () => ({ disconnect: () => calls.push("disconnect"), conversationManager: {} }) },
    configureSDK: () => ({ connect: () => calls.push("connect") }),
    startAgentStream: (channel: { channelID: string }) => calls.push(`stream:${channel.channelID}`),
    startSession: (next: ReturnType<typeof envelope>) => { context.session.value = next; },
    syncConversations: noop, syncGroups: noop, refreshActiveHistory: noop,
    openPendingConversation: noop, refreshAgentPresentation: noop, readAgentCapabilities: noop,
    batch: { refreshHidden: noop, reset: noop }, agentDirectory: { clear: noop },
    removeListeners: noop, resetNames: noop,
    timers: [] as Array<{ fn: () => void; ms: number; cleared?: boolean }>,
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms, due: context.clock + ms }; context.timers.push(t); return t; },
    clearTimeout: (t?: { cleared?: boolean }) => { if (t) t.cleared = true; },
    viewGeneration: 0, streamAbort: undefined, directoryEpoch: 0,
    directoryReading: undefined, directoryTimer: undefined, pendingConversationTarget: null,
    shellBridge: { reportAuthRequired: noop },
    navigator: { get onLine() { return onlineState; } },
    shellSignedOut: () => { calls.push("signed-out"); context.session.value = undefined; },
    clearCachedContacts: noop, clearCachedProfile: noop, signInViaShell: noop,
  };
  for (const name of [
    "managementOpen", "canManageAgents", "conversations", "groups", "directoryAgents",
    "directoryError", "knownContacts", "menu", "listMenuOpen", "hiddenOpen", "searchOpen",
    "profileName", "profileAvatar", "profileRoles", "dialOpen", "dialOpenId", "dialError",
    "activeGroupMembers", "messages", "liveResponses", "password", "loginError", "loggingIn",
  ]) context[name] = ref();
  runInNewContext(source, context);
  const run = (code: string) => runInNewContext(code, context);
  return {
    context, calls, pending, run,
    status: (status: number, reason = 2) => run(`connectStatusListener(${status}, ${reason})`),
    adopt: (token: string, principal?: string | null) =>
      run(`adoptShellSession(${JSON.stringify(token)}${principal === undefined ? "" : ", " + JSON.stringify(principal)})`),
  };
}

for (const closeBeforeFailure of [true, false]) {
  test(`rejection, close ${closeBeforeFailure ? "before" : "after"} old mint failure, fresh credential recovers`, async () => {
    const f = fixture();
    const channel = f.context.activeChannel.value;
    f.status(3);
    if (closeBeforeFailure) f.status(0);
    f.pending[0].reject(new Error("401"));
    await flush();
    if (!closeBeforeFailure) f.status(0);
    assert.equal(f.context.connection.value, "disconnected");
    const recovery = f.adopt(jwt(2));
    assert.equal(f.pending.length, 2);
    f.pending[1].resolve(envelope(jwt(2)));
    await recovery;
    assert.deepEqual(f.calls, [`mint:${jwt(1)}`, `mint:${jwt(2)}`, "disconnect", "connect"]);
    assert.equal(f.context.draft.value, "unsent draft");
    assert.equal(f.context.activeChannel.value, channel);
    assert.equal(f.context.session.value.uid, "11");
    f.status(3);
    f.status(0);
    await f.adopt(jwt(2));
    assert.equal(f.pending.length, 2, "unchanged rejected credential must not loop");
  });
}

for (const state of ["connected", "connecting", "disconnected"]) {
  test(`ordinary ${state} renewal does not mint`, async () => {
    const f = fixture(state);
    if (state === "disconnected") f.status(0);
    await f.adopt(jwt(2));
    assert.deepEqual(f.calls, []);
    assert.equal(f.context.session.value.jwt, jwt(2));
  });
}

test("successful connection clears recovery and resets the retry guard", async () => {
  const f = fixture();
  f.status(3);
  f.pending[0].reject(new Error("401"));
  await flush();
  f.status(1);
  f.status(0);
  await f.adopt(jwt(2));
  assert.equal(f.pending.length, 1);
  f.status(3);
  assert.equal(f.pending.length, 2);
  f.pending[1].reject(new Error("401"));
  await flush();
});

for (const replacement of [false, true]) {
  for (const rejectOld of [false, true]) {
    test(`${replacement ? "account switch" : "teardown"} fences old mint ${rejectOld ? "failure" : "success"}`, async () => {
      const f = fixture();
      f.status(3);
      if (replacement) {
        const switching = f.adopt(jwt(2, 22));
        f.pending[1].resolve(envelope(jwt(2, 22), "22"));
        await switching;
      } else {
        f.run("teardownSession()");
      }
      const current = f.context.session.value;
      if (rejectOld) f.pending[0].reject(new Error("401"));
      else f.pending[0].resolve(envelope(jwt(1)));
      await flush();
      assert.equal(f.context.session.value, current);
      assert.equal(f.calls.filter((call) => call === "connect").length, 0);
      assert.equal(f.run("authRecoveryNeeded"), false);
      assert.equal(f.run("remint.take()"), true);
      if (replacement) {
        await f.adopt(jwt(3, 22));
        assert.equal(f.pending.length, 2, "new account must not inherit recovery");
      }
    });
  }
}

for (const rejectOld of [false, true]) {
  test(`fresh recovery fences overlapping old mint ${rejectOld ? "failure" : "success"}`, async () => {
    const f = fixture();
    f.status(3);
    f.status(0);
    const recovery = f.adopt(jwt(2));
    await f.adopt(jwt(2));
    assert.equal(f.pending.length, 2);
    f.pending[1].resolve(envelope(jwt(2)));
    await recovery;
    const current = f.context.session.value;
    if (rejectOld) f.pending[0].reject(new Error("401"));
    else f.pending[0].resolve(envelope(jwt(1)));
    await flush();
    assert.equal(f.context.session.value, current);
    assert.equal(f.calls.filter((call) => call === "connect").length, 1);
  });
}

// MUYU-161: after a shell cross-tab revalidation the view (draft, open channel) survives;
// the same user's proven token re-mints and reconnects, another user tears it down.
test("revalidation resume: same user keeps draft and channel, re-mints once, reconnects", async () => {
  const f = fixture();
  const channel = f.context.activeChannel.value;
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  assert.equal(f.pending.length, 1);
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.deepEqual(f.calls, [`mint:${jwt(2)}`, "disconnect", "connect", "stream:kept-channel"]);
  assert.equal(f.context.draft.value, "unsent draft");
  assert.equal(f.context.activeChannel.value, channel);
  assert.equal(f.run("revalidationPending"), false);
});

test("revalidation resume with the unchanged token still reconnects (socket was closed)", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(1));
  f.pending[0].resolve(envelope(jwt(1)));
  await resume;
  assert.deepEqual(f.calls, [`mint:${jwt(1)}`, "disconnect", "connect", "stream:kept-channel"]);
});

test("revalidation resolving to a different user tears the old view down (fail-closed)", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const other = f.adopt(jwt(2, 22));
  assert.equal(f.context.draft.value === "unsent draft" && f.context.session.value?.uid === "11", false);
  f.pending[0].resolve(envelope(jwt(2, 22), "22"));
  await other;
  assert.equal(f.context.session.value.uid, "22");
  assert.equal(f.run("revalidationPending"), false);
});

test("teardown clears a pending revalidation", () => {
  const f = fixture();
  f.run("revalidationPending = true");
  f.run("teardownSession()");
  assert.equal(f.run("revalidationPending"), false);
});

test("revalidation resume whose re-mint fails retries on the next same-user renewal", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(new Error("401"));
  await resume;
  assert.equal(f.run("authRecoveryNeeded"), true);
  const retry = f.adopt(jwt(3));
  assert.equal(f.pending.length, 2, "next renewal must re-mint");
  f.pending[1].resolve(envelope(jwt(3)));
  await retry;
  assert.ok(f.calls.includes("connect"));
});

test("revalidation resume survives the shell's duplicate token delivery during the re-mint", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.run("shellAuthGeneration += 1"); // duplicate delivery of the same proven token
  await f.adopt(jwt(2));
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.equal(f.pending.length, 1, "the duplicate must not mint again");
  assert.deepEqual(f.calls, [`mint:${jwt(2)}`, "disconnect", "connect", "stream:kept-channel"]);
  assert.equal(f.context.draft.value, "unsent draft");
});

// MUYU-161 DEV 30-min foreground: the shell renewed exactly as the network dropped, the
// re-mint fetch failed in transport, the SDK socket was already closed with reconnect off,
// and nothing ever reconnected (stuck on 连接中 for 120 s after the network came back).
test("a re-mint that fails in transport is retried with backoff and reconnects", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await resume;
  const retry = f.context.timers.filter((t: any) => !t.cleared).at(-1);
  assert.equal(retry?.ms, 2000);
  retry.fn();
  assert.equal(f.pending.length, 2, "retry mints again");
  f.pending[1].resolve(envelope(jwt(2)));
  await flush();
  assert.ok(f.calls.includes("connect"));
  assert.equal(f.context.draft.value, "unsent draft");
});

test("coming back online retries a pending re-mint at once", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await resume;
  f.run("remintWhenOnline()");
  assert.equal(f.pending.length, 2);
});

test("a server refusal of the re-mint is not retried on a timer (fail-closed, no loop)", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(Object.assign(new Error("unauthorized"), { status: 401 })); // a real refusal carries the HTTP status
  await resume;
  assert.equal(f.context.timers.filter((t: any) => !t.cleared && t.ms === 2000).length, 0);
  assert.equal(f.pending.length, 1);
});

test("sign-out or account switch cancels a pending transport retry", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await resume;
  const retry = f.context.timers.filter((t: any) => !t.cleared).at(-1);
  f.run("teardownSession()");
  assert.equal(retry.cleared, true);
  f.run("remintWhenOnline()");
  assert.equal(f.pending.length, 1, "no mint after teardown");
});

// Independent review MUST-FIX: while a shell revalidation is pending nothing is trusted,
// so neither a scheduled transport retry nor `online` may mint and reconnect.
test("a pending revalidation blocks the transport retry and the online re-mint", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await resume;
  const retry = f.context.timers.filter((t: any) => !t.cleared).at(-1);
  f.run("revalidationPending = true"); // another tab starts a new revalidation (state as onAuth sets it)
  retry.fn();
  f.run("remintWhenOnline()");
  assert.equal(f.pending.length, 1, "no mint while revalidating");
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
});

test("a mint that resolves after a new revalidation started does not reconnect", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.run("revalidationPending = true");
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
});

test("transport retries are bounded", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await resume;
  for (let i = 1; i < 20; i++) {
    const t = f.context.timers.filter((x: any) => !x.cleared && !x.fired).at(-1);
    if (!t) break;
    t.fired = true;
    t.fn();
    f.pending.at(-1)!.reject(new TypeError("Failed to fetch"));
    await flush();
  }
  assert.equal(f.pending.length, 7, "exactly 1 + 6 bounded retries");
});

test("duplicate re-mint triggers for the same session share one mint", async () => {
  const f = fixture();
  f.run("authRecoveryNeeded = true");
  const a = f.run("remintConnectToken()");
  f.run("remintWhenOnline()");
  f.run("remintConnectToken()");
  assert.equal(f.pending.length, 1);
  f.pending[0].resolve(envelope(jwt(1)));
  await a;
  assert.equal(f.calls.filter((c) => c === "connect").length, 1);
});

// MUYU-161 (regression guard for the App side, independent of the bridge barrier): a same-user
// re-mint in flight when the shell signs out must not reconnect or restore anything
// (teardown fences it by session identity).
test("sign-out during an in-flight same-user re-mint does not revive the old session", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2));
  f.run("teardownSession()");
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.equal(f.context.session.value, undefined);
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
  assert.equal(f.calls.filter((c) => c.startsWith("stream:")).length, 0);
});

// MUYU-161 (real DEV traces 2026-10-27 07:59 and 09:09): when the shell's cross-tab proof
// fails it still pushes the stored token with principal null. ONLINE that means the server
// refused it: fail closed. OFFLINE it proves nothing: the IM server proves it once back online.
let onlineState = true;
const setOnline = (on: boolean) => { onlineState = on; };
const refusal = () => Object.assign(new Error("unauthorized"), { status: 401 });

test("ONLINE: revalidation ending on an UNPROVEN token signs out; its duplicate cannot sign in", async () => {
  setOnline(true);
  const f = fixture();
  f.run("revalidationPending = true");
  await f.adopt(jwt(2), null);
  assert.ok(f.calls.includes("signed-out"));
  await f.adopt(jwt(2), null); // the shell's second delivery
  await f.adopt(jwt(2));       // and a copy without the field
  assert.equal(f.pending.length, 0, "never minted on the unproven credential");
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
});

test("OFFLINE: an UNPROVEN token keeps the view, no stream, until the server proves it", async () => {
  setOnline(false);
  const f = fixture();
  const channel = f.context.activeChannel.value;
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  assert.ok(!f.calls.includes("signed-out"));
  assert.equal(f.calls.filter((c) => c.startsWith("stream:")).length, 0, "no stream before the proof");
  assert.equal(f.pending.length, 1, "the server is asked to prove the credential");
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.ok(f.calls.includes("connect"));
  assert.ok(f.calls.includes("stream:kept-channel"), "stream resumes only after the proof");
  assert.equal(f.context.draft.value, "unsent draft");
  assert.equal(f.context.activeChannel.value, channel);
  setOnline(true);
});

test("OFFLINE then refused (401) signs out; a 5xx or bad gateway is retried, not a refusal", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  f.pending[0].reject(Object.assign(new Error("Bad gateway"), { status: 502 }));
  await resume;
  assert.ok(!f.calls.includes("signed-out"), "5xx is not a refusal");
  const retry = f.context.timers.filter((t: any) => !t.cleared).at(-1);
  retry.fn();
  f.pending[1].reject(refusal());
  await flush();
  assert.ok(f.calls.includes("signed-out"));
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
  assert.equal(f.calls.filter((c) => c.startsWith("stream:")).length, 0);
  setOnline(true);
});

test("OFFLINE: the server resolving the token to ANOTHER uid signs out", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  f.pending[0].resolve(envelope(jwt(2), "22"));
  await resume;
  assert.ok(f.calls.includes("signed-out"));
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
  setOnline(true);
});

test("OFFLINE: transport failure keeps waiting; coming back online proves and resumes", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await resume;
  assert.ok(!f.calls.includes("signed-out"));
  setOnline(true);
  f.run("remintWhenOnline()");
  f.pending[1].resolve(envelope(jwt(2)));
  await flush();
  assert.ok(f.calls.includes("connect"));
  assert.ok(f.calls.includes("stream:kept-channel"));
});

test("a refusal arriving after a NEW revalidation started does not sign out", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  f.run("revalidationPending = true");
  f.pending[0].reject(refusal());
  await resume;
  assert.ok(!f.calls.includes("signed-out"));
  setOnline(true);
});

test("revalidation ending on a token proven for ANOTHER user signs out instead of resuming", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  await f.adopt(jwt(2), "22");
  assert.ok(f.calls.includes("signed-out"));
  assert.equal(f.pending.length, 0);
});

test("revalidation ending on a token proven for the same user resumes", async () => {
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), "11");
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.ok(!f.calls.includes("signed-out"));
  assert.ok(f.calls.includes("connect"));
  assert.equal(f.context.draft.value, "unsent draft");
});

test("teardown clears a pending server proof", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  f.run("teardownSession()");
  f.pending[0].resolve(envelope(jwt(2)));
  await resume;
  assert.equal(f.run("proofUid"), undefined);
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
  setOnline(true);
});

test("OFFLINE: a duplicate or field-less copy of the unproven token keeps the proof pending; 401 still signs out", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  await f.adopt(jwt(2), null); // the shell's second delivery
  await f.adopt(jwt(2));       // a copy without the principal field
  assert.notEqual(f.run("proofUid"), undefined, "the pending proof survives duplicates");
  f.pending[0].reject(Object.assign(new Error("unauthorized"), { status: 401 }));
  await resume;
  assert.ok(f.calls.includes("signed-out"));
  assert.equal(f.calls.filter((c) => c === "connect").length, 0);
  assert.equal(f.calls.filter((c) => c.startsWith("stream:")).length, 0);
  setOnline(true);
});

test("a 401 gateway page (invalid JSON) is a refusal, not a transport retry", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  f.pending[0].reject(Object.assign(new Error("Server returned invalid JSON (401)"), { status: 401 }));
  await resume;
  assert.ok(f.calls.includes("signed-out"));
  setOnline(true);
});

test("OFFLINE proof pending, then the shell's PROVEN same-user token completes it with the stream", async () => {
  setOnline(false);
  const f = fixture();
  f.run("revalidationPending = true");
  const first = f.adopt(jwt(2), null);
  f.pending[0].reject(new TypeError("Failed to fetch"));
  await first;
  setOnline(true);
  const proven = f.adopt(jwt(3), "11");
  assert.equal(f.run("proofUid"), undefined);
  f.pending.at(-1)!.resolve(envelope(jwt(3)));
  await proven;
  await flush();
  assert.ok(f.calls.includes("connect"));
  assert.ok(f.calls.includes("stream:kept-channel"));
  assert.equal(f.context.draft.value, "unsent draft");
});

const CONNECTED = 1, CONNECT_FAIL = 3, DISCONNECT = 0;
// MUYU-161 D10 (real PROD traces kickdiag-prod / kickdiag-prod2, 2026-10-27 10:14 and 10:18Z):
// with a second same-account web IM tab, every connect lived ~3.4 s, then CONNACK rc=2 (auth-fail)
// -> one re-mint -> reconnect -> the other tab's token fails -> it re-mints ... 13 opens / 14 closes
// in 45 s and 8/8 in 27 s, never settling. A re-mint per auth-fail must not loop like that.
async function displaced(f: ReturnType<typeof fixture>, livedMs: number) {
  f.status(CONNECTED);
  f.context.clock += livedMs;
  f.status(DISCONNECT, 0); // the server closed this tab's socket (another tab minted)
  f.context.clock += 3_000; // the SDK's reconnect delay
  f.status(CONNECT_FAIL); // the old token is no longer registered: CONNACK rc=2
  const minted = f.pending.length;
  f.pending.at(-1)?.resolve(envelope(jwt(1)));
  await flush();
  return minted;
}

test("two-tab displacement (kickdiag trace): this tab stops re-minting after a bounded number of quick losses", async () => {
  const f = fixture();
  const mints: number[] = [];
  for (let i = 0; i < 8; i++) mints.push(await displaced(f, 3_400));
  assert.equal(f.pending.length, 1, "bounded: the first quick loss still re-mints once, the second yields");
  assert.deepEqual(mints, [1, 1, 1, 1, 1, 1, 1, 1], "no further mint after yielding (the trace looped every ~7 s)");
  assert.equal(f.context.connection.value, "conflict");
  assert.equal(f.run("authRecoveryNeeded"), false, "nothing re-mints by itself while yielding");
  assert.equal(f.context.draft.value, "unsent draft");
  assert.equal(f.context.activeChannel.value?.channelID, "kept-channel");
});

test("yielding: a same-user renewal, `online` and a pending retry timer do not re-mint", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  const before = f.pending.length;
  assert.equal(f.context.connection.value, "conflict");
  await f.adopt(jwt(2)); // routine renewal of the same user
  f.run("remintWhenOnline()");
  for (const t of f.context.timers.filter((x: any) => !x.cleared)) t.fn();
  assert.equal(f.pending.length, before, "the other tab keeps the connection");
  assert.equal(f.context.session.value.jwt, jwt(2), "the renewal itself is still adopted");
});

test("explicit 'use here' re-mints once and reconnects; the other tab then yields first", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  const before = f.pending.length;
  f.run("takeOverConnection()");
  assert.equal(f.pending.length, before + 1);
  assert.equal(f.context.connection.value, "connecting");
  f.pending.at(-1)!.resolve(envelope(jwt(1)));
  await flush();
  assert.ok(f.calls.filter((c) => c === "connect").length >= 1);
  // The takeover outlasts the other tab: two more quick losses still re-mint here...
  assert.equal(await displaced(f, 3_400), before + 2);
  assert.equal(await displaced(f, 3_400), before + 3);
  // ...but it stays bounded: it yields again rather than looping.
  for (let i = 0; i < 4; i++) await displaced(f, 3_400);
  assert.equal(f.context.connection.value, "conflict");
  assert.ok(f.pending.length <= before + 5);
});

test("'use here' does nothing unless this tab is yielding, or while a revalidation is pending", () => {
  const f = fixture();
  f.run("takeOverConnection()");
  assert.equal(f.pending.length, 0);
  f.context.connection.value = "conflict";
  f.run("revalidationPending = true");
  f.run("takeOverConnection()");
  assert.equal(f.pending.length, 0, "nothing is trusted during a revalidation");
});

test("a WuKong reset (one auth-fail after a long-lived connection) still re-mints every time", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) await displaced(f, 10 * 60_000);
  assert.equal(f.pending.length, 6, "long-lived connections are never treated as a conflict");
  assert.notEqual(f.context.connection.value, "conflict");
});

test("an auth-fail with no connection in between is the re-mint guard's case, not a conflict", async () => {
  const f = fixture();
  f.status(CONNECT_FAIL);
  f.pending[0].reject(Object.assign(new Error("unauthorized"), { status: 401 }));
  await flush();
  f.status(CONNECT_FAIL);
  f.status(CONNECT_FAIL);
  assert.equal(f.pending.length, 1, "unchanged: one re-mint per failure streak");
  assert.equal(f.context.connection.value, "authFailed");
});

test("plain disconnects (network loss) never count toward a conflict", async () => {
  const f = fixture();
  for (let i = 0; i < 6; i++) {
    f.status(CONNECTED);
    f.context.clock += 3_000;
    f.status(DISCONNECT);
  }
  assert.equal(f.context.connection.value, "disconnected");
  f.status(CONNECTED);
  f.context.clock += 3_000;
  f.status(CONNECT_FAIL);
  assert.equal(f.pending.length, 1, "the first auth-fail still re-mints");
});

test("a stable connection between quick losses resets the count", async () => {
  const f = fixture();
  await displaced(f, 3_400);
  await displaced(f, 5 * 60_000);
  await displaced(f, 3_400);
  assert.notEqual(f.context.connection.value, "conflict");
  assert.equal(f.pending.length, 3);
});

test("teardown (sign-out / account switch) clears a yielded conflict", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  assert.equal(f.context.connection.value, "conflict");
  f.run("teardownSession()");
  f.context.session.value = envelope(jwt(5));
  f.status(CONNECTED);
  f.context.clock += 3_400;
  f.status(CONNECT_FAIL);
  assert.equal(f.context.connection.value, "authFailed", "a fresh session starts with no conflict history");
});

// Independent review (r30) follow-ups.
test("review: quick losses far apart (days, WuKong rolling restarts) never add up to a conflict", async () => {
  const f = fixture();
  await displaced(f, 3_400);            // one odd quick loss
  f.context.clock += 3 * 86_400_000;    // days later, after many plain reconnects
  for (let i = 0; i < 3; i++) { f.status(CONNECTED); f.context.clock += 3_000; f.status(DISCONNECT, 0); }
  await displaced(f, 3_400);            // a WuKong restart right after a network blip
  assert.notEqual(f.context.connection.value, "conflict");
  assert.equal(f.pending.length, 2, "it still re-mints");
});

test("review: a connection's lifetime ends at the socket close, not at the later auth-fail", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    f.status(CONNECTED);
    f.context.clock += 3_400;
    f.status(DISCONNECT, 0);
    f.context.clock += 60_000; // a throttled background tab reconnects late
    f.status(CONNECT_FAIL);
    f.pending.at(-1)?.resolve(envelope(jwt(1)));
    await flush();
  }
  assert.equal(f.context.connection.value, "conflict", "still a displacement: the connection lived 3.4 s");
});

test("review: a cross-tab revalidation does not make a yielded tab take the connection back", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  const before = f.pending.length;
  f.run("revalidationPending = true");
  await f.adopt(jwt(2), "11"); // the same user's proven token
  assert.equal(f.pending.length, before, "no mint: the other tab keeps the connection");
  assert.equal(f.context.connection.value, "conflict");
  assert.equal(f.run("revalidationPending"), false);
  assert.equal(f.context.session.value.jwt, jwt(2));
  assert.equal(f.context.draft.value, "unsent draft");
});

test("review: a yielded tab whose unproven token needs the IM server's proof still asks once (fail-closed kept)", async () => {
  onlineState = false;
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  const before = f.pending.length;
  f.run("revalidationPending = true");
  const resume = f.adopt(jwt(2), null);
  assert.equal(f.pending.length, before + 1, "the proof needs one mint");
  f.pending.at(-1)!.reject(Object.assign(new Error("unauthorized"), { status: 401 }));
  await resume;
  assert.ok(f.calls.includes("signed-out"), "a refused proof still signs out");
  onlineState = true;
});

test("review: 'use here' refused by the server (401) shows authFailed, not an endless 正在重连", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  f.run("takeOverConnection()");
  f.pending.at(-1)!.reject(Object.assign(new Error("unauthorized"), { status: 401 }));
  await flush(); await flush();
  assert.equal(f.context.connection.value, "authFailed");
});

test("review: 'use here' failing in transport returns to the conflict bar and probes later (D11 review 3 replaced the 2 s retry)", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  f.run("takeOverConnection()");
  const n = f.pending.length;
  f.pending.at(-1)!.reject(new TypeError("Failed to fetch"));
  await flush(); await flush();
  assert.equal(f.context.connection.value, "conflict");
  assert.ok(probeTimers(f).length, "a later bounded probe is armed instead");
  fireProbe(f);
  assert.equal(f.pending.length, n + 1);
});

test("review: the yielded tab's socket close keeps the conflict bar (not 重连)", async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  f.status(DISCONNECT, 0);
  assert.equal(f.context.connection.value, "conflict");
});

// Two tabs running this code against one server that keeps only the newest token.
test("review: two tabs against a one-connection server settle with exactly one connected", async () => {
  const server = { owner: "" };
  const tabs = ["A", "B"].map((name) => ({ name, f: fixture() }));
  const connect = async (tab: typeof tabs[number]) => {
    const other = tabs.find((t) => t !== tab)!;
    server.owner = tab.name;
    tab.f.status(CONNECTED);
    // The other tab, if connected, is closed by the server and its reconnect auth-fails.
    if (other.f.context.connection.value === "connected") {
      other.f.context.clock += 3_400;
      other.f.status(DISCONNECT, 0);
      other.f.context.clock += 3_000;
      other.f.status(CONNECT_FAIL);
    }
  };
  for (const t of tabs) t.f.context.clock = 1_000_000;
  await connect(tabs[0]);
  await connect(tabs[1]);
  for (let round = 0; round < 12; round++) {
    let progressed = false;
    for (const t of tabs) {
      if (t.f.pending.length && !t.f.pending.at(-1)!.done) {
        const p = t.f.pending.at(-1)! as any; p.done = true;
        p.resolve(envelope(jwt(1)));
        await flush();
        await connect(t);
        progressed = true;
      }
    }
    if (!progressed) break;
  }
  const states = tabs.map((t) => t.f.context.connection.value).sort();
  assert.deepEqual(states, ["conflict", "connected"]);
  const mints = tabs.reduce((n, t) => n + t.f.pending.length, 0);
  assert.ok(mints <= 3, `bounded mints, got ${mints}`);
});

test("review 2: a stale refusal does not leak into a later takeover's outcome", async () => {
  const f = fixture();
  f.run("remintRefused = true"); // left over from an earlier refused re-mint
  for (let i = 0; i < 3; i++) await displaced(f, 3_400);
  f.run("takeOverConnection()");
  f.run("revalidationPending = true"); // the mint result is fenced by a new revalidation
  f.pending.at(-1)!.resolve(envelope(jwt(1)));
  await flush(); await flush();
  assert.notEqual(f.context.connection.value, "authFailed");
});

// Review 2: both tabs re-mint at the same time (both pending). The server keeps only the LAST
// registered token: a tab connects only while it holds it; otherwise its connect gets rc=2.
for (const order of [["A", "B"], ["B", "A"]]) {
  for (const connectFirst of [true, false]) {
    test(`review 2: concurrent re-mints (register ${order.join("→")}, ${connectFirst ? "connect before" : "connect after"} the other registers) settle on one connected`, async () => {
      const server = { owner: "" };
      const tabs = Object.fromEntries(["A", "B"].map((n) => [n, fixture()]));
      for (const f of Object.values(tabs)) f.context.clock = 1_000_000;
      const kicked = (f: ReturnType<typeof fixture>) => {
        f.context.clock += 3_400; f.status(DISCONNECT, 0); f.context.clock += 3_000; f.status(CONNECT_FAIL);
      };
      const tryConnect = (name: string) => {
        const f = tabs[name];
        if (server.owner === name) f.status(CONNECTED); else { f.context.clock += 100; f.status(CONNECT_FAIL); }
      };
      // Both had connected; a third party's mint kicked both at once, so both re-mint together.
      for (const f of Object.values(tabs)) f.status(CONNECTED);
      for (const f of Object.values(tabs)) kicked(f);
      for (let round = 0; round < 10; round++) {
        const minting = order.filter((n) => tabs[n].pending.length && !(tabs[n].pending.at(-1) as any).done);
        if (!minting.length) break;
        for (const n of minting) {
          (tabs[n].pending.at(-1) as any).done = true;
          const previous = server.owner;
          server.owner = n; // registration
          tabs[n].pending.at(-1)!.resolve(envelope(jwt(1)));
          await flush();
          if (connectFirst) tryConnect(n);
          // The previous holder, if connected, is closed by the server; its reconnect fails.
          if (previous && previous !== n && tabs[previous].context.connection.value === "connected") kicked(tabs[previous]);
        }
        if (!connectFirst) for (const n of minting) tryConnect(n);
        for (const n of order) {
          if (n !== server.owner && tabs[n].context.connection.value === "connected") kicked(tabs[n]);
        }
      }
      const states = order.map((n) => tabs[n].context.connection.value);
      assert.equal(states.filter((x) => x === "connected").length, 1, `exactly one connected: ${states}`);
      assert.equal(tabs[server.owner].context.connection.value, "connected", "the token holder is the connected tab");
      assert.ok(Object.values(tabs).reduce((n, f) => n + f.pending.length, 0) <= 4, "bounded mints");
    });
  }
}

// ---------------------------------------------------------------------------------------------
// MUYU-161 D11 — real DEV trace twotab-dev run 1 (2026-10-27 11:26:43–11:27:02Z, both tabs on 9222):
// B opens -> A displaced -> A re-mints -> B displaced -> B re-mints -> ... the server accepted two
// concurrent connections and then closed both; A and B each saw two quick auth-fail losses and
// BOTH yielded (30/30 samples "A=冲突 B=冲突") until the user clicked "use here" 74 s later.
// Required: a bounded automatic recovery to exactly one connected tab, without displacing a tab
// that holds the connection, and without weakening refusal / other-user fail-closed handling.
// ---------------------------------------------------------------------------------------------

/** One browser's BroadcastChannel bus (same-origin tabs hear each other; never their own posts). */
function bus() {
  const members = new Set<any>();
  return class FakeChannel {
    listeners: Array<(e: { data: unknown }) => void> = [];
    constructor() { members.add(this); }
    addEventListener(_: string, fn: (e: { data: unknown }) => void) { this.listeners.push(fn); }
    postMessage(data: unknown) { for (const m of members) if (m !== this) m.listeners.forEach((fn: any) => fn({ data: structuredClone(data) })); }
    close() { members.delete(this); }
  };
}

/** Drive a tab into the yielded state exactly as the DEV trace did (two quick auth-fail losses). */
async function yieldLikeTrace(f: ReturnType<typeof fixture>) {
  for (let i = 0; i < 2; i++) await displaced(f, 2_000);
  assert.equal(f.context.connection.value, "conflict");
}
const live = (f: ReturnType<typeof fixture>) => f.context.timers.filter((t: any) => !t.cleared && !t.fired);
const fire = (t: any) => { t.fired = true; t.fn(); };
/** The tab's own probe (or peer re-check) timer, if armed. */
const probeTimers = (f: ReturnType<typeof fixture>) => { const t = f.run("probeTimer"); return t && !t.cleared && !t.fired ? [t] : []; };
/** Fire the armed probe and, if it asked the channel, the short decision wait that follows. */
const fireProbe = (f: ReturnType<typeof fixture>) => {
  const t = probeTimers(f).at(-1); if (!t) return false;
  // Real time passes until the probe is due (rounds have a duration; D13 bounds the round rate by it).
  if (typeof t.due === "number" && t.due > f.context.clock) f.context.clock = t.due;
  fire(t);
  const q = probeTimers(f).at(-1);
  if (q && (q.ms === PEER_QUERY_WAIT_MS || q.ms === 0)) fire(q);
  return true;
};

test("D11 DEV trace: a yielded tab recovers by itself (bounded probe), keeping draft and channel", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  const before = f.pending.length;
  const probe = probeTimers(f).at(-1);
  assert.ok(probe, "a probe is scheduled after yielding");
  assert.ok(probe.ms >= 6_000 && probe.ms <= 6_000 * 1.6, `first probe in [6 s, 9.6 s], got ${probe.ms}`);
  fireProbe(f);
  assert.equal(f.pending.length, before + 1, "the probe re-mints once");
  f.pending.at(-1)!.resolve(envelope(jwt(1)));
  await flush();
  f.status(CONNECTED);
  assert.equal(f.context.connection.value, "connected");
  assert.equal(f.context.draft.value, "unsent draft");
  assert.equal(f.context.activeChannel.value?.channelID, "kept-channel");
});

/**
 * Two tabs against a one-connection server on one shared clock. Every armed timer of either tab
 * fires in due order (probes, peer re-checks, heartbeats, stability); every mint either tab starts
 * resolves, registers its token (displacing the previous holder: socket closed, reconnect rc=2).
 */
async function replay(tabs: Record<string, ReturnType<typeof fixture>>, minutes = 5) {
  const server = { owner: "" };
  const done = new Set<unknown>();
  let mints = 0;
  const settle = async () => {
    for (let guard = 0; guard < 50; guard++) {
      const next = Object.entries(tabs).map(([n, f]) => ({ n, f, p: f.pending.find((p) => !done.has(p)) })).find((x) => x.p);
      if (!next) return;
      done.add(next.p); mints += 1;
      const previous = server.owner;
      server.owner = next.n;
      next.p!.resolve(envelope(jwt(1)));
      await flush();
      next.f.status(CONNECTED);
      if (previous && previous !== next.n && tabs[previous].context.connection.value === "connected") {
        for (const f of Object.values(tabs)) f.context.clock += 2_000;
        tabs[previous].status(DISCONNECT, 0);
        for (const f of Object.values(tabs)) f.context.clock += 3_000;
        tabs[previous].status(CONNECT_FAIL);
      }
    }
    throw new Error("unbounded displacement in replay");
  };
  for (const f of Object.values(tabs)) for (const p of f.pending) done.add(p);
  const t0 = Math.max(...Object.values(tabs).map((f) => f.context.clock));
  for (const f of Object.values(tabs)) f.context.clock = t0;
  for (let step = 0; step < 2_000; step++) {
    const next = Object.values(tabs).flatMap((f) => live(f).map((t: any) => ({ f, t }))).sort((x, y) => x.t.due - y.t.due)[0];
    if (!next || next.t.due > t0 + minutes * 60_000) break;
    const now = Math.max(next.t.due, ...Object.values(tabs).map((f) => f.context.clock));
    for (const f of Object.values(tabs)) f.context.clock = now;
    fire(next.t);
    await settle();
  }
  return { owner: server.owner, mints };
}

for (const sameBrowser of [true, false]) {
  test(`D11 DEV trace replay (${sameBrowser ? "same browser" : "two browsers, cannot hear each other"}): both yielded -> exactly one connected, bounded`, async () => {
    for (const [ra, rb] of [[0.1, 0.9], [0.9, 0.1], [0.5, 0.5], [0, 0], [1, 1]]) {
      const tabs: Record<string, ReturnType<typeof fixture>> = {
        A: fixture("connected", { channel: sameBrowser ? bus() : undefined, random: () => ra }),
        B: fixture("connected", { channel: undefined, random: () => rb }),
      };
      if (sameBrowser) { const C = bus(); tabs.A = fixture("connected", { channel: C, random: () => ra }); tabs.B = fixture("connected", { channel: C, random: () => rb }); }
      for (const f of Object.values(tabs)) f.context.clock = 1_000_000;
      for (const f of Object.values(tabs)) await yieldLikeTrace(f);
      const { owner, mints } = await replay(tabs);
      const states = Object.values(tabs).map((f) => f.context.connection.value).sort();
      assert.deepEqual(states, ["conflict", "connected"], `random ${ra}/${rb}: ${states}`);
      assert.equal(tabs[owner].context.connection.value, "connected", "the token holder is the connected tab");
      assert.ok(mints <= 2 * PROBE_DELAYS_MS.length + 2, `bounded mints after both yielded: ${mints}`);
    }
  });
}

test("D11: a probe never displaces a same-browser tab that reports a live connection", async () => {
  const Channel = bus();
  const winner = fixture("connected", { channel: Channel });
  const loser = fixture("connected", { channel: Channel });
  winner.status(CONNECTED); // announces "connected"
  await yieldLikeTrace(loser);
  const before = loser.pending.length;
  fireProbe(loser);
  assert.equal(loser.pending.length, before, "no mint while the peer holds the connection");
  // The winner closes its tab: it releases, and the yielded tab takes over by itself.
  winner.run("teardownSession()");
  assert.ok(probeTimers(loser).length, "the release re-arms a probe");
  fireProbe(loser);
  assert.equal(loser.pending.length, before + 1);
});

test("D11: a peer that vanished silently (crash) stops blocking once its report is stale", async () => {
  const Channel = bus();
  const winner = fixture("connected", { channel: Channel });
  const loser = fixture("connected", { channel: Channel });
  winner.status(CONNECTED);
  winner.run("clearTimeout(heartbeatTimer)"); // the winner crashes: no heartbeats, no answers
  winner.context.connection.value = "crashed";
  await yieldLikeTrace(loser);
  fireProbe(loser); // blocked: schedules a re-check after PEER_FRESH_MS
  const recheck = live(loser).find((t: any) => t.ms === PEER_FRESH_MS);
  assert.ok(recheck, "a re-check is scheduled");
  loser.context.clock += PEER_FRESH_MS + 1; // no heartbeat arrived meanwhile
  fire(recheck);
  const before = loser.pending.length;
  fireProbe(loser);
  assert.equal(loser.pending.length, before + 1, "probes once the peer went quiet");
});

test("D11: automatic probes are bounded (cross-browser peer that keeps winning)", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  let mints = f.pending.length;
  for (let i = 0; i < 10; i++) {
    if (!fireProbe(f)) break;
    if (f.pending.length === mints) break;
    mints = f.pending.length;
    f.pending.at(-1)!.resolve(envelope(jwt(1)));
    await flush();
    await displaced(f, 2_000); // the other browser's tab takes it straight back
  }
  assert.equal(f.pending.length, 1 + PROBE_DELAYS_MS.length, "one trace re-mint + at most PROBE_DELAYS_MS.length probes");
  assert.equal(f.context.connection.value, "conflict");
  assert.ok(f.calls.length > 0);
});

test("D11: probe delays grow and carry jitter", async () => {
  const delays: number[] = [];
  const f = fixture("connected", { random: () => 1 });
  await yieldLikeTrace(f);
  for (let i = 0; i < PROBE_DELAYS_MS.length; i++) {
    delays.push(probeTimers(f).at(-1).ms); fireProbe(f);
    f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
    await displaced(f, 2_000);
  }
  assert.deepEqual(delays, PROBE_DELAYS_MS.map((d: number) => d * (1 + PROBE_JITTER)));
});

test("D11: a probe refused by the server (401) does not loop and the bar leaves 正在重连", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  fireProbe(f);
  f.pending.at(-1)!.reject(Object.assign(new Error("unauthorized"), { status: 401 }));
  await flush(); await flush();
  assert.equal(probeTimers(f).length, 0, "no further automatic probe after a refusal");
  assert.equal(f.context.connection.value, "authFailed", "review MUST-FIX 1: not stuck on 正在重连");
  assert.equal(f.run("probesUsed"), PROBE_DELAYS_MS.length, "budget closed");
  assert.equal(f.context.timers.filter((t: any) => !t.cleared && t.ms === 2000).length, 0, "no transport retry");
});

test("D11: no probe during a revalidation, after sign-out, or for another account", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("revalidationPending = true");
  const n = f.pending.length;
  fireProbe(f);
  assert.equal(f.pending.length, n, "nothing is trusted during a revalidation");
  assert.ok(probeTimers(f).length, "review MUST-FIX 2: the probe is re-armed, not lost");
  const g = fixture();
  await yieldLikeTrace(g);
  const u = probeTimers(g).at(-1);
  g.run("teardownSession()");
  assert.equal(u.cleared, true, "sign-out cancels the probe");
  const h = fixture();
  await yieldLikeTrace(h);
  h.context.session.value = envelope(jwt(9, 22), "22"); // account switched underneath
  const m = h.pending.length;
  fireProbe(h);
  assert.equal(h.pending.length, m);
});

test("D11: a holding connection earns the probe budget back; a quick one does not", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  for (let i = 0; i < PROBE_DELAYS_MS.length; i++) { fireProbe(f); f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush(); await displaced(f, 2_000); }
  assert.equal(probeTimers(f).length, 0, "budget spent");
  f.run("takeOverConnection()");
  f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
  f.status(CONNECTED);
  const quick = live(f).find((t: any) => t.ms === CONFLICT_WINDOW_MS);
  f.status(DISCONNECT, 0); // lost before the window: the budget stays spent
  assert.equal(quick.cleared, true);
  assert.equal(f.run("probesUsed"), PROBE_DELAYS_MS.length, "a quick connection does not earn the budget back");
  f.status(CONNECTED);
  const stable = live(f).find((t: any) => t.ms === CONFLICT_WINDOW_MS);
  fire(stable); // held for the whole window
  assert.equal(f.run("probesUsed"), 0);
});

// Renewal vs loop (PROD twotab first run, 11:56:32Z): the connected tab's routine cross-tab
// revalidation re-mints once (server proof, by design); the yielded tab stays yielded. That is one
// bounded reconnect, not the displacement loop: no further mints follow.
test("D11: a renewal revalidation in the connected tab is one bounded re-mint; the yielded tab stays yielded", async () => {
  const Channel = bus();
  const a = fixture("connected", { channel: Channel });
  const b = fixture("connected", { channel: Channel });
  a.status(CONNECTED);
  await yieldLikeTrace(b);
  const bMints = b.pending.length;
  a.run("revalidationPending = true");
  const resume = a.adopt(jwt(2), "11");
  assert.equal(a.pending.length, 1, "exactly one re-mint for the proven credential");
  a.pending[0].resolve(envelope(jwt(2)));
  await resume;
  a.status(CONNECTED);
  b.run("revalidationPending = true");
  await b.adopt(jwt(2), "11");
  fireProbe(b); // a is live (heartbeat): b must not probe
  assert.equal(b.pending.length, bMints, "the yielded tab neither re-mints nor probes");
  assert.equal(b.context.connection.value, "conflict");
  assert.equal(a.context.connection.value, "connected");
});



// Review r31 follow-ups.
test("D11 review: a throttled background holder still answers the probe's query, so it is not displaced", async () => {
  const C = bus();
  const winner = fixture("connected", { channel: C });
  const loser = fixture("connected", { channel: C });
  winner.status(CONNECTED);
  winner.run("clearTimeout(heartbeatTimer)"); // background-throttled: no heartbeat for minutes
  await yieldLikeTrace(loser);
  loser.context.clock += 10 * 60_000; // its last report is long stale
  const before = loser.pending.length;
  fireProbe(loser);
  assert.equal(loser.pending.length, before, "the live holder answered the query");
});

test("D11 review: a renewal revalidation ending in stayYielded re-arms the probe", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("clearTimeout(probeTimer)");
  f.run("revalidationPending = true");
  await f.adopt(jwt(2), "11");
  assert.equal(f.context.connection.value, "conflict");
  assert.ok(probeTimers(f).length, "probe re-armed after the revalidation");
});

test("D11 review: offline the probe waits (no budget spent) and tries again later", async () => {
  onlineState = false;
  const f = fixture();
  await yieldLikeTrace(f);
  const n = f.pending.length;
  fireProbe(f);
  assert.equal(f.pending.length, n);
  assert.equal(f.run("probesUsed"), 0);
  assert.ok(probeTimers(f).length, "re-check armed");
  onlineState = true;
});

test("D11 review: only a tab that held the connection announces a release", async () => {
  const C = bus();
  const a = fixture("connected", { channel: C });
  const b = fixture("connected", { channel: C });
  await yieldLikeTrace(b);
  const armed = probeTimers(b)[0];
  a.status(DISCONNECT, 0); // never connected in this run: no release
  assert.equal(probeTimers(b)[0], armed, "b's probe timing is not reset by a non-holder");
});

// Two browsers (cannot hear each other) on a server that, like the real DEV trace, may accept two
// concurrent connections and then close BOTH. Every mint either tab starts (probe, or the normal
// re-mint after a long-lived connection was taken) resolves and connects. Bounded: it ends with at
// most one connected, never loops; both yielded only if their probes kept colliding ("use here").
test("D11 review: cross-browser, server closes both on concurrent connects: bounded, never loops", async () => {
  for (const [ra, rb] of [[0, 0], [1, 1], [0.3, 0.31], [0.1, 0.9], [0.9, 0.1]]) {
    const tabs: Record<string, ReturnType<typeof fixture>> = {
      A: fixture("connected", { random: () => ra }), B: fixture("connected", { random: () => rb }),
    };
    for (const f of Object.values(tabs)) f.context.clock = 1_000_000;
    for (const f of Object.values(tabs)) await yieldLikeTrace(f);
    const done = new Set<unknown>(); for (const f of Object.values(tabs)) for (const p of f.pending) done.add(p);
    const t0 = Math.max(...Object.values(tabs).map((f) => f.context.clock));
    for (const f of Object.values(tabs)) f.context.clock = t0;
    const at = () => tabs.A.context.clock;
    const advance = (ms: number) => { for (const f of Object.values(tabs)) f.context.clock += ms; };
    let mints = 0; let owner = ""; let ownerSince = -1e9;
    const settle = async () => {
      for (let guard = 0; guard < 40; guard++) {
        const next = Object.entries(tabs).map(([n, f]) => ({ n, f, p: f.pending.find((p) => !done.has(p)) })).find((x) => x.p);
        if (!next) return;
        done.add(next.p); mints += 1;
        next.p!.resolve(envelope(jwt(1))); await flush();
        next.f.status(CONNECTED);
        const prev = owner && owner !== next.n && tabs[owner].context.connection.value === "connected" ? tabs[owner] : undefined;
        const both = !!prev && at() - ownerSince < 1_000;
        if (prev) {
          advance(2_000); prev.status(DISCONNECT, 0); if (both) next.f.status(DISCONNECT, 0);
          advance(3_000); prev.status(CONNECT_FAIL); if (both) next.f.status(CONNECT_FAIL);
        }
        owner = both ? "" : next.n; ownerSince = at();
      }
      throw new Error("unbounded displacement");
    };
    for (let step = 0; step < 500; step++) {
      const next = Object.values(tabs).flatMap((f) => live(f).map((t: any) => ({ f, t }))).sort((x, y) => x.t.due - y.t.due)[0];
      if (!next || next.t.due > t0 + 10 * 60_000) break;
      for (const f of Object.values(tabs)) f.context.clock = Math.max(next.t.due, f.context.clock);
      fire(next.t);
      await settle();
    }
    const states = Object.values(tabs).map((f) => f.context.connection.value);
    assert.ok(states.filter((x) => x === "connected").length <= 1, `at most one connected: ${states}`);
    assert.ok(states.every((x) => x === "connected" || x === "conflict"), `settled: ${states}`);
    assert.ok(mints <= 4 * PROBE_DELAYS_MS.length, `bounded: ${mints}`);
  }
});

// Review r31 round 2.
test("D11 review 2: a probe whose fresh token is displaced BEFORE it connects yields again (conflict + re-armed), not authFailed", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  fireProbe(f);
  f.pending.at(-1)!.resolve(envelope(jwt(1)));
  await flush();
  f.status(CONNECT_FAIL); // the other tab's mint won the race: rc=2 before any Connected
  assert.equal(f.context.connection.value, "conflict");
  assert.ok(probeTimers(f).length, "probe re-armed (budget permitting)");
  assert.ok(f.context.draft.value === "unsent draft");
});

test("D11 review 2: 'use here' displaced before it connects returns to conflict with the button", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("takeOverConnection()");
  f.pending.at(-1)!.resolve(envelope(jwt(1)));
  await flush();
  f.status(CONNECT_FAIL);
  assert.equal(f.context.connection.value, "conflict");
});

test("D11 review 2: a tab that is probing answers queries, so two yielded tabs of one browser never mint together", async () => {
  const C = bus();
  const a = fixture("connected", { channel: C, random: () => 0 });
  const b = fixture("connected", { channel: C, random: () => 0 });
  await yieldLikeTrace(a);
  await yieldLikeTrace(b);
  // a's probe decides first and mints; b's query arrives while a is still minting.
  fire(probeTimers(a).at(-1)); fire(probeTimers(a).at(-1));
  assert.equal(a.run("probing"), true);
  const n = b.pending.length;
  fireProbe(b);
  assert.equal(b.pending.length, n, "b sees a as holding and does not mint");
});

test("D11 review 2: a probe that fails in transport (5xx) returns to the conflict bar and probes later", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  fireProbe(f);
  f.pending.at(-1)!.reject(Object.assign(new Error("Bad gateway"), { status: 502 }));
  await flush(); await flush();
  assert.equal(f.context.connection.value, "conflict");
  assert.equal(f.run("probing"), false);
  assert.ok(probeTimers(f).length, "next probe armed");
  assert.equal(f.context.timers.filter((t: any) => !t.cleared && t.ms === 2000).length, 0, "no parallel transport retry");
});

test("D11 review 2: a refused takeover stops claiming the connection", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("takeOverConnection()");
  f.pending.at(-1)!.reject(Object.assign(new Error("unauthorized"), { status: 401 }));
  await flush(); await flush();
  assert.equal(f.context.connection.value, "authFailed");
  assert.equal(f.run("probing"), false);
});

// Review r31 round 3 (SHOULD-FIX 1, 2).
test("D11 review 3: after a probe's transport failure the tab is truly yielded (a revalidation does not mint)", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  fireProbe(f);
  f.pending.at(-1)!.reject(Object.assign(new Error("Bad gateway"), { status: 502 }));
  await flush(); await flush();
  const n = f.pending.length;
  f.run("revalidationPending = true");
  await f.adopt(jwt(2), "11");
  assert.equal(f.pending.length, n, "stays yielded: no mint on the revalidation");
  assert.equal(f.context.connection.value, "conflict");
});

test("D11 review 3: a takeover that fails in transport returns to the conflict bar and stops claiming", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("takeOverConnection()");
  f.pending.at(-1)!.reject(new TypeError("Failed to fetch"));
  await flush(); await flush();
  assert.equal(f.context.connection.value, "conflict");
  assert.equal(f.run("probing"), false);
  assert.equal(f.context.timers.filter((t: any) => !t.cleared && t.ms === 2000).length, 0);
});


// MUYU-161 D12 — real PRE trace acc-pre-r33-fgn (2026-10-27 15:26–15:34Z): a rival in ANOTHER browser
// (same account) took the connection; the long-window tab yielded, spent its probes while the rival
// was still there, then the rival left — and the tab never looked again: idle and after a 60 s
// network drop it stayed "conflict" (recover 120215 ms timeout). Required: bounded re-arm.
async function spendBudget(f: ReturnType<typeof fixture>) {
  await yieldLikeTrace(f);
  for (let i = 0; i < PROBE_DELAYS_MS.length; i++) {
    if (!fireProbe(f)) break;
    f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
    await displaced(f, 2_000); // the rival in the other browser takes it straight back
  }
  assert.equal(probeTimers(f).length, 0, "budget spent");
  assert.equal(f.context.connection.value, "conflict");
}

test("D12 PRE trace: after the budget is spent, the network coming back re-arms the bounded probe", async () => {
  const f = fixture();
  await spendBudget(f);
  const n = f.pending.length;
  f.run("rearmProbe()"); // window `online`
  assert.ok(probeTimers(f).length, "re-armed");
  fireProbe(f);
  assert.equal(f.pending.length, n + 1, "the rival left: this probe connects");
  f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
  f.status(CONNECTED);
  assert.equal(f.context.connection.value, "connected");
  assert.equal(f.context.draft.value, "unsent draft");
});

test("D12: the tab becoming visible re-arms; a hidden transition does not", async () => {
  const f = fixture();
  await spendBudget(f);
  f.context.document.visibilityState = "hidden";
  f.run("rearmWhenVisible()");
  assert.equal(probeTimers(f).length, 0);
  f.context.document.visibilityState = "visible";
  f.run("rearmWhenVisible()");
  assert.ok(probeTimers(f).length);
});

test("D12: re-arm does nothing unless yielded, during a revalidation, or signed out", async () => {
  const f = fixture();
  f.run("rearmProbe()");
  assert.equal(probeTimers(f).length, 0, "connected tab: nothing to do");
  await spendBudget(f);
  f.run("revalidationPending = true");
  f.run("rearmProbe()");
  assert.equal(probeTimers(f).length, 0);
  f.run("revalidationPending = false");
  f.run("teardownSession()");
  f.run("rearmProbe()");
  assert.equal(probeTimers(f).length, 0);
});

test("D12: a re-armed budget is still bounded (the rival keeps winning)", async () => {
  const f = fixture();
  await spendBudget(f);
  const n = f.pending.length;
  f.run("rearmProbe()");
  for (let i = 0; i < 20; i++) {
    if (!fireProbe(f)) break;
    f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
    await displaced(f, 2_000);
  }
  assert.equal(f.pending.length - n, PROBE_DELAYS_MS.length, "one more bounded round, no endless probing");
  assert.equal(probeTimers(f).length, 0);
});


// D12 review follow-ups.
test("D13: a round still waiting out a long delay is pulled forward on online (superseded D12 'spent only')", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  // Spend 4 of 5 probes against a rival that keeps winning; the 5th is armed with the longest delay.
  for (let i = 0; i < PROBE_DELAYS_MS.length - 1; i++) { fireProbe(f); f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush(); await displaced(f, 2_000); }
  assert.equal(f.run("probesUsed"), PROBE_DELAYS_MS.length - 1, "budget NOT spent (read directly)");
  assert.equal(f.run("probeState.value.used"), PROBE_DELAYS_MS.length - 1, "the bar's read-only state agrees");
  const longOne = probeTimers(f)[0];
  assert.ok(longOne.ms >= PROBE_DELAYS_MS.at(-1), `armed long delay ${longOne.ms}`);
  f.run("rearmProbe()"); // window online
  const pulled = probeTimers(f)[0];
  assert.ok(pulled && pulled !== longOne && pulled.ms <= PROBE_DELAYS_MS[0] * (1 + PROBE_JITTER), `pulled forward to ${pulled?.ms}`);
  const n = f.pending.length;
  fireProbe(f);
  assert.equal(f.pending.length, n + 1, "the rival left: the pulled-forward probe mints");
  assert.equal(f.run("probesUsed"), PROBE_DELAYS_MS.length, "it used the last budget slot: bound unchanged");
  f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
  f.status(CONNECTED);
  assert.equal(f.context.connection.value, "connected");
});

test("D13: pulling forward keeps the per-round bound (no extra mint beyond the budget) [single round]", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  let mints = f.pending.length;
  for (let i = 0; i < 20; i++) {
    f.context.clock += CONFLICT_WINDOW_MS + 1; // throttle window passes every time
    f.run("rearmProbe()");
    if (!fireProbe(f)) break;
    if (f.pending.length === mints) break;
    mints = f.pending.length;
    f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
    await displaced(f, 2_000);
    if (f.run("probesUsed") >= PROBE_DELAYS_MS.length) break;
  }
  assert.ok(f.run("probesUsed") <= PROBE_DELAYS_MS.length);
  assert.ok(f.pending.length - 1 <= PROBE_DELAYS_MS.length, `bounded per round: ${f.pending.length - 1}`);
});

test("D12 review: repeated visibility flips re-arm at most once per conflict window", async () => {
  const f = fixture();
  await spendBudget(f);
  f.run("rearmWhenVisible()");
  const first = probeTimers(f)[0];
  assert.ok(first);
  // The re-armed round is spent again quickly (rival keeps winning)...
  for (let i = 0; i < PROBE_DELAYS_MS.length; i++) { if (!fireProbe(f)) break; f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush(); await displaced(f, 2_000); }
  const n = f.pending.length;
  f.run("lastRearmAt = performance.now()"); // a re-arm just happened
  f.run("rearmWhenVisible()");
  assert.equal(probeTimers(f).length, 0, "throttled");
  f.context.clock += CONFLICT_WINDOW_MS + 1;
  f.run("rearmWhenVisible()");
  assert.ok(probeTimers(f).length, "allowed again after the window");
  assert.equal(f.pending.length, n);
});

test("D12 review: after a re-arm, a live same-browser holder still blocks the probe", async () => {
  const C = bus();
  const f = fixture("connected", { channel: C });
  await spendBudget(f); // spent against a rival in another browser (not on this channel)
  const holder = fixture("connected", { channel: C }); // a same-browser tab now holds it
  holder.status(CONNECTED);
  const n = f.pending.length;
  f.run("rearmProbe()");
  fireProbe(f);
  assert.equal(f.pending.length, n, "no mint over a live holder");
});

test("D12 review: a re-armed probe while offline waits without spending budget", async () => {
  const f = fixture();
  await spendBudget(f);
  onlineState = false;
  f.run("rearmProbe()");
  const n = f.pending.length;
  fireProbe(f);
  assert.equal(f.pending.length, n);
  assert.equal(f.run("probesUsed"), 0);
  onlineState = true;
});

test("D12 review: no re-arm while connecting, probing or authFailed", async () => {
  for (const state of ["connecting", "authFailed", "connected", "disconnected"]) {
    const f = fixture();
    await spendBudget(f);
    f.context.connection.value = state;
    f.run("rearmProbe()");
    assert.equal(probeTimers(f).length, 0, state);
  }
});

test("D12 review: App registers and removes the online / visibility re-arm listeners", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(app, /window\.addEventListener\("online", rearmProbe\)/);
  assert.match(app, /document\.addEventListener\("visibilitychange", rearmWhenVisible\)/);
  assert.match(app, /window\.removeEventListener\("online", rearmProbe\)/);
  assert.match(app, /document\.removeEventListener\("visibilitychange", rearmWhenVisible\)/);
});


// D13 review follow-ups.
test("D13 review: one hour of online/visible every 30 s against a rival that keeps winning stays at an undisturbed rate", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  const t0 = f.context.clock; const start = f.pending.length;
  while (f.context.clock - t0 < 60 * 60_000) {
    f.context.clock += 30_000;
    f.run("rearmProbe()");
    // let any probe that is due fire (rival takes the connection straight back)
    for (const t of probeTimers(f)) {
      if (t.due > f.context.clock) continue;
      fireProbe(f);
      const p = f.pending.at(-1) as any;
      if (p && !p.done) { p.done = true; p.resolve(envelope(jwt(1))); await flush(); await displaced(f, 2_000); }
    }
  }
  const mints = f.pending.length - start;
  // undisturbed: PROBE_DELAYS_MS.length per round, a round no sooner than every PROBE_DELAYS_MS.at(-1)
  const cap = Math.ceil((60 * 60_000) / PROBE_DELAYS_MS.at(-1)) * PROBE_DELAYS_MS.length;
  assert.ok(mints <= cap, `mints/hour ${mints} <= ${cap}`);
});

test("D13 review: only one pull-forward per round", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("rearmProbe()");
  const first = probeTimers(f)[0];
  f.context.clock += CONFLICT_WINDOW_MS + 1;
  f.run("rearmProbe()");
  assert.equal(probeTimers(f)[0], first, "second pull in the same round is ignored");
});

test("D13 review: a pulled-forward probe still yields to a live same-browser holder without spending budget", async () => {
  const C = bus();
  const f = fixture("connected", { channel: C });
  await yieldLikeTrace(f);
  const holder = fixture("connected", { channel: C });
  holder.status(CONNECTED);
  const used = f.run("probesUsed"), n = f.pending.length;
  f.run("rearmProbe()");
  fireProbe(f);
  assert.equal(f.pending.length, n);
  assert.equal(f.run("probesUsed"), used);
});

test("D13 review: a pulled-forward probe whose session changed meanwhile does nothing", async () => {
  const f = fixture();
  await yieldLikeTrace(f);
  f.run("rearmProbe()");
  const t = probeTimers(f)[0];
  f.context.session.value = envelope(jwt(9, 22), "22");
  const n = f.pending.length;
  t.fired = true; t.fn();
  assert.equal(f.pending.length, n);
});

test("D13 review: the connection bar exposes only the two counters, and only while yielded", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  assert.match(app, /:data-probes-used="connection === 'conflict' \? probeState\.used : undefined"/);
  assert.match(app, /:data-probe-budget="connection === 'conflict' \? probeState\.budget : undefined"/);
});



/** Realistic path to "spent before the round boundary": 4 probes on their own schedule, then an online
 * event pulls the 5th forward; the rival wins every time. Returns the round start. Clock only moves forward. */
async function spendWithPull(f: ReturnType<typeof fixture>) {
  await yieldLikeTrace(f);
  const win = async () => { const p = f.pending.at(-1) as any; if (p && !p.done) { p.done = true; p.resolve(envelope(jwt(1))); await flush(); await displaced(f, 2_000); } };
  for (let i = 0; i < PROBE_DELAYS_MS.length - 1; i++) { fireProbe(f); await win(); }
  f.run("rearmProbe()"); // pull the last (long) probe forward
  fireProbe(f); await win();
  assert.equal(f.run("probesUsed"), PROBE_DELAYS_MS.length);
  const started = f.run("roundStartedAt");
  assert.ok(f.context.clock - started < PROBE_DELAYS_MS.at(-1) - CONFLICT_WINDOW_MS - 1, `spent ${f.context.clock - started} ms after the round began`);
  f.context.clock += CONFLICT_WINDOW_MS + 1; // the next event is allowed by the 30 s throttle, still before the boundary
  return started;
}

test("D13 review 2: an online event too early for a new round is deferred to the round boundary, not dropped", async () => {
  const f = fixture();
  const started = await spendWithPull(f);
  f.run("rearmProbe()"); // the network came back, but too early for a new round
  const deferred = probeTimers(f)[0];
  assert.ok(deferred, "deferred, not dropped");
  assert.ok(Math.abs(deferred.due - (started + PROBE_DELAYS_MS.at(-1))) < 2, "due at the round boundary");
  const n = f.pending.length;
  f.context.clock = deferred.due; deferred.fired = true; deferred.fn();
  fireProbe(f);
  assert.equal(f.pending.length, n + 1, "the new round starts by itself");
  f.pending.at(-1)!.resolve(envelope(jwt(1))); await flush();
  f.status(CONNECTED);
  assert.equal(f.context.connection.value, "connected");
});

test("D13 NIT1: a deferred new round that comes due during a revalidation is retried, not dropped", async () => {
  const f = fixture();
  await spendWithPull(f);
  f.run("rearmProbe()");
  const deferred = probeTimers(f)[0];
  assert.ok(deferred);
  f.run("revalidationPending = true");
  const n0 = f.pending.length;
  f.context.clock = deferred.due; deferred.fired = true; deferred.fn();
  assert.equal(f.pending.length, n0, "no mint during the revalidation");
  f.run("revalidationPending = false");
  await f.adopt(jwt(2), "11"); // the revalidation ends with the tab still yielded
  assert.equal(f.context.connection.value, "conflict");
  const retry = probeTimers(f)[0];
  assert.ok(retry, "still armed after the revalidation (0 before this fix)");
  const n = f.pending.length;
  f.context.clock = retry.due; retry.fired = true; retry.fn();
  fireProbe(f);
  assert.equal(f.pending.length, n + 1, "the new round probes by itself");
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { ref } from "vue";
import { renewsSameUser } from "../src/api.ts";
import { remintGuard } from "../src/history.ts";

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

function fixture(state = "connected") {
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
    setTimeout: (fn: () => void, ms: number) => { const t = { fn, ms }; context.timers.push(t); return t; },
    clearTimeout: (t?: { cleared?: boolean }) => { if (t) t.cleared = true; },
    viewGeneration: 0, streamAbort: undefined, directoryEpoch: 0,
    directoryReading: undefined, directoryTimer: undefined, pendingConversationTarget: null,
    shellBridge: { reportAuthRequired: noop },
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
    status: (status: number) => run(`connectStatusListener(${status}, 2)`),
    adopt: (token: string) => run(`adoptShellSession(${JSON.stringify(token)})`),
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
  f.pending[0].reject(new Error("401 unauthorized"));
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

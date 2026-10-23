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
    startSession: (next: ReturnType<typeof envelope>) => { context.session.value = next; },
    syncConversations: noop, syncGroups: noop, refreshActiveHistory: noop,
    openPendingConversation: noop, refreshAgentPresentation: noop, readAgentCapabilities: noop,
    batch: { refreshHidden: noop, reset: noop }, agentDirectory: { clear: noop },
    removeListeners: noop, resetNames: noop, clearTimeout: noop,
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

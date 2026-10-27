import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { parse } from "@vue/compiler-sfc";
import { resolveConversationTarget } from "../src/conversationTarget.ts";

// Execute the actual App handlers with only the network/SDK boundaries stubbed.
const app = parse(readFileSync(new URL("../src/App.vue", import.meta.url), "utf8"));
const source = ts.createSourceFile("App.ts", app.descriptor.scriptSetup!.content, ts.ScriptTarget.Latest, true);
const names = new Set(["openPendingConversation", "openChannel", "adoptShellSession",
  "pendingConversationTarget", "shellAuthGeneration", "shellBridge", "connectStatusListener",
  "shellSignedOut", "revalidationPending", "revalidationTimer", "SHELL_REVALIDATION_MS",
  "remintRetryTimer", "proofUid", "unprovenRejected"]);
const handlers = source.statements.filter((node) =>
  ts.isFunctionDeclaration(node) ? names.has(node.name?.text ?? "") :
    ts.isVariableStatement(node) && node.declarationList.declarations.some((d) =>
      ts.isIdentifier(d.name) && names.has(d.name.text)));
const code = ts.transpileModule(handlers.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;

function harness() {
  const requests: Array<{ channelID: string; channelType: number }> = [];
  const history = [{ messageID: "persisted-message" }];
  let intents: any;
  let finishLogin: (value: unknown) => void = () => {};
  const state: Record<string, any> = {
    resolveConversationTarget,
    session: { value: undefined }, connection: { value: "disconnected" },
    activeChannel: { value: undefined }, activeGroupMembers: { value: [] },
    messages: { value: [] }, draft: { value: "" }, mentionedAgentUids: { value: [] }, mentionedPersonUids: { value: [] },
    historyFinished: { value: false }, loadingHistory: { value: false },
    loginError: { value: "" }, loggingIn: { value: false }, groups: { value: [] },
    viewGeneration: 0, ChannelTypeGroup: 2, ChannelTypePerson: 1,
    t: (key: string) => key,
    memberGroups: [{ wukongChannelId: "group-4" }] as Array<{ wukongChannelId: string }> | Error,
    listGroups: async () => {
      if (state.memberGroups instanceof Error) throw state.memberGroups;
      return state.memberGroups;
    },
    Channel: class {
      channelID: string;
      channelType: number;
      constructor(id: string, type: number) { this.channelID = id; this.channelType = type; }
    },
    PullMode: { Up: 0 },
    ConnectStatus: { Connected: 1, Connecting: 2, ConnectFail: 3, Disconnect: 4 },
    WKSDK: { shared: () => ({
      chatManager: { syncMessages: async (channel: any) => {
        requests.push({ channelID: channel.channelID, channelType: channel.channelType });
        return history;
      } },
      conversationManager: { findConversation: () => null, createEmptyConversation: () => ({}) },
    }) },
    startAgentStream() {}, markChannelRead() {}, reconcileResponses() {}, scrollToBottom() {},
    unknownGroup: () => false, refreshGroups: async () => {},
    mergeMessages: (_old: unknown, next: unknown) => next,
    renewsSameUser: () => false,
    imSession: () => new Promise((resolve) => { finishLogin = resolve; }),
    startSession: (session: unknown) => { state.session.value = session; },
    teardownSession: () => {
      state.session.value = undefined;
      state.activeChannel.value = undefined;
      state.messages.value = [];
      state.viewGeneration++;
      state.connection.value = "disconnected";
    },
    clearCachedContacts() {}, clearCachedProfile() {}, signInViaShell() {},
    setTimeout, clearTimeout, streamAbort: undefined,
    installShellBridge: (options: unknown) => {
      intents = options;
      return { reportAuthRequired() {} };
    },
    remint: { reset() {} }, conflict: { connected() {}, lost() {}, authFailed: () => false, yielded: () => false, reset() {} }, monotonicNow: () => 0, remintRefused: false, leaveConnected() {}, heartbeat() {}, scheduleProbe() {}, probing: false, probeTimer: undefined, stableTimer: undefined, probesUsed: 0, CONFLICT_WINDOW_MS: 30000, syncConversations() {}, syncGroups() {}, refreshActiveHistory() {},
    refreshAgentPresentation() {}, readAgentCapabilities() {},
    batch: { refreshHidden() {} },
  };
  const context = createContext(state);
  runInContext(code, context);
  return { state, requests, history, intents,
    login: (uid: string) => finishLogin({ uid, jwt: "fixture" }),
    connected: () => runInContext("connectStatusListener(ConnectStatus.Connected)", context),
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));
const dm = { channelId: "1@17", channelType: 1, agentUid: "17" };

test("shell target before login/connection opens the viewer's DM and loads persisted history once", async () => {
  const h = harness();
  h.intents.onAuth({ token: "fixture" });
  h.intents.onConversation(dm);
  assert.equal(h.requests.length, 0);
  h.login("1");
  await flush();
  assert.equal(h.requests.length, 0);
  h.connected();
  await flush();
  assert.deepEqual(h.requests, [{ channelID: "17", channelType: 1 }]);
  assert.deepEqual(h.state.messages.value, h.history);
  assert.equal(h.state.loadingHistory.value, false);
  h.connected();
  await flush();
  assert.equal(h.requests.length, 1);
});

test("connected group target opens that group and replaces its history", async () => {
  const h = harness();
  h.state.session.value = { uid: "1" };
  h.connected();
  h.intents.onConversation({ channelId: "group-4", channelType: 2, agentUid: "17" });
  await flush();
  assert.deepEqual(h.requests, [{ channelID: "group-4", channelType: 2 }]);
  assert.deepEqual(h.state.messages.value, h.history);
});

test("a DM for another viewer never requests history and says why (T17)", async () => {
  const h = harness();
  h.state.session.value = { uid: "2" };
  h.connected();
  h.intents.onConversation(dm);
  await flush();
  assert.deepEqual(h.requests, []);
  assert.equal(h.state.loginError.value, "chat.targetUnavailable");
});

test("a group the viewer is not in (or that is gone) shows a notice, not a blank pane (T17)", async () => {
  const h = harness();
  h.state.session.value = { uid: "1" };
  h.state.memberGroups = [{ wukongChannelId: "group-other" }];
  h.connected();
  h.intents.onConversation({ channelId: "group-4", channelType: 2, agentUid: "17" });
  await flush();
  assert.deepEqual(h.requests, []);
  assert.equal(h.state.activeChannel.value, undefined);
  assert.equal(h.state.loginError.value, "chat.targetUnavailable");
});

test("if the membership check itself fails, the group still opens (T17)", async () => {
  const h = harness();
  h.state.session.value = { uid: "1" };
  h.state.memberGroups = new Error("im down");
  h.connected();
  h.intents.onConversation({ channelId: "group-4", channelType: 2, agentUid: "17" });
  await flush();
  assert.deepEqual(h.requests, [{ channelID: "group-4", channelType: 2 }]);
  assert.equal(h.state.loginError.value, "");
});

test("signout invalidates a pending login and its conversation target", async () => {
  const h = harness();
  h.intents.onAuth({ token: "old-login" });
  h.intents.onConversation(dm);
  h.intents.onAuth({ token: null });
  h.login("1");
  await flush();
  h.connected();
  await flush();
  assert.equal(h.state.session.value, undefined);
  assert.deepEqual(h.requests, []);
});

// SELFDM-403: search row / card / dial on your own uid used to open uid@uid, which im answers 403.
test("opening a DM with yourself sends nothing and says why; another person still opens", async () => {
  const h = harness();
  let streams = 0, reads = 0;
  h.state.startAgentStream = () => { streams++; };
  h.state.markChannelRead = () => { reads++; };
  h.state.session.value = { uid: "11" };
  await runInContext("openChannel(new Channel('11', ChannelTypePerson))", h.state);
  assert.deepEqual(h.requests, []);
  assert.equal(streams + reads, 0);
  assert.equal(h.state.activeChannel.value, undefined);
  assert.equal(h.state.loginError.value, "chat.selfChat");

  h.state.loginError.value = "";
  await runInContext("openChannel(new Channel('13', ChannelTypePerson))", h.state);
  assert.deepEqual(h.requests, [{ channelID: "13", channelType: 1 }]);
  assert.equal(streams + reads, 2);
  assert.equal(h.state.loginError.value, "");
});

test("MUYU-161: a shell revalidation through the real onAuth keeps the view and shows connecting", async () => {
  const h = harness();
  h.intents.onAuth({ token: "old-login", sessionVersion: 1 });
  h.login("1");
  await flush();
  h.connected();
  await flush();
  h.state.WKSDK = { shared: () => ({ disconnect() {}, chatManager: {}, conversationManager: {} }) };
  h.intents.onAuth({ token: null, sessionVersion: 2, revalidating: true });
  assert.ok(h.state.session.value, "view kept during revalidation");
  assert.equal(h.state.connection.value, "connecting");
});

test("MUYU-161: after the 12 s revalidation timeout signs out locally, the shell's same-version proven token is accepted again", async () => {
  const h = harness();
  h.intents.onAuth({ token: "old-login", sessionVersion: 1 });
  h.login("1");
  await flush();
  h.connected();
  await flush();
  h.state.WKSDK = { shared: () => ({ disconnect() {}, chatManager: {}, conversationManager: {} }) };
  const timers: Array<() => void> = [];
  h.state.setTimeout = (fn: () => void) => { timers.push(fn); return timers.length; };
  h.intents.onAuth({ token: null, sessionVersion: 2, revalidating: true });
  timers.at(-1)!(); // the shell's proof never arrived in time
  assert.equal(h.state.session.value, undefined, "timed-out revalidation signs out (fail-closed)");
  // The shell later pushes the credential it really holds for version 2: a fresh sign-in.
  h.intents.onAuth({ token: "proven-v2", sessionVersion: 2 });
  h.login("1");
  await flush();
  assert.ok(h.state.session.value, "same-version proven token after a local timeout signs in again");
});

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
  "pendingConversationTarget", "shellAuthGeneration", "shellBridge", "connectStatusListener"]);
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
    messages: { value: [] }, draft: { value: "" }, mentionedAgentUids: { value: [] },
    historyFinished: { value: false }, loadingHistory: { value: false },
    loginError: { value: "" }, loggingIn: { value: false }, groups: { value: [] },
    viewGeneration: 0, ChannelTypeGroup: 2,
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
    installShellBridge: (options: unknown) => {
      intents = options;
      return { reportAuthRequired() {} };
    },
    remint: { reset() {} }, syncConversations() {}, syncGroups() {}, refreshActiveHistory() {},
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

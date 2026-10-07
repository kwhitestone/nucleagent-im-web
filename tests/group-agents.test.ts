import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChannelTypeGroup } from "wukongimjssdk";
import { buildOutgoingText } from "../src/mentions.ts";
import { resetNames } from "../src/names.ts";
import { loadComponent, render } from "./render.ts";

const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
const agent = { uid: 37, name: "Test agent", description: "Payroll helper" };
const member = { uid: 37, username: "test-agent", displayName: "Test agent", avatar: "https://example.test/avatar.png", accountType: "agent" };
const group = { id: 8, creatorUid: 1, title: "Test group", wukongChannelId: "group_8" };
type Component = { setup: (...args: any[]) => Record<string, any> };

test("group picker lists agents before search, selects IM UID, excludes existing/selected and supports removal", async () => {
  const Picker = await loadComponent("src/components/ContactPicker.vue") as Component;
  const original = Picker.setup;
  const events: any[][] = [];
  let state: Record<string, any>;
  Picker.setup = (props, context) => {
    state = original(props, { ...context, emit: (...args: any[]) => events.push(args) });
    return state;
  };
  const props = { session, agents: [agent], multiple: true };
  assert.match(await render(Picker, props), /im-search-agents[\s\S]*Test agent/);
  state!.chooseAgent(agent);
  const selected = events.at(-1)![1];
  assert.deepEqual(selected, [{ id: 37, username: "Test agent", displayName: "Test agent", accountType: "agent" }]);
  assert.equal(events.some(([name]) => name === "agent"), false, "selection must not open a DM");
  assert.doesNotMatch(await render(Picker, { ...props, excludeUids: [37] }), /im-search-agents/);
  const count = events.length;
  state!.chooseAgent(agent);
  assert.equal(events.length, count, "excluded agents cannot be selected");
  assert.doesNotMatch(await render(Picker, { ...props, modelValue: selected }), /im-search-agents/);
  state!.chooseAgent(agent);
  assert.equal(events.length, count, "selected agents cannot be duplicated");
  state!.remove(selected[0]);
  assert.deepEqual(events.at(-1), ["update:modelValue", []]);
});

test("group picker reuses name/description search and exclusions", async () => {
  const Picker = await loadComponent("src/components/ContactPicker.vue") as Component;
  const original = Picker.setup;
  Picker.setup = (props, context) => {
    const state = original(props, context);
    state.query.value = "payroll";
    return state;
  };
  assert.match(await render(Picker, { session, agents: [agent], multiple: true }), /Test agent/);
  assert.doesNotMatch(await render(Picker, { session, agents: [agent], multiple: true, excludeUids: [37] }), /Test agent/);
});

test("create/add submit IM UIDs, refresh agent membership, and render avatar plus badge", async () => {
  const originalFetch = globalThis.fetch;
  const writes: Array<{ path: string; body: any }> = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    let data: unknown = {};
    if (init?.method === "POST") {
      writes.push({ path, body: JSON.parse(init.body as string) });
      data = group;
    } else if (path.includes("/allowlist")) {
      data = { agentUid: 37, memberUids: [], ownerImplicit: true };
    } else if (path.endsWith("/members")) {
      data = { group, members: [member] };
    } else {
      data = { items: [], degraded: false };
    }
    return new Response(JSON.stringify({ code: 0, data }));
  };
  try {
    const Dialog = await loadComponent("src/components/GroupDialog.vue") as Component;
    const original = Dialog.setup;
    const events: any[][] = [];
    let state: Record<string, any>;
    Dialog.setup = (props, context) => {
      state = original(props, { ...context, emit: (...args: any[]) => events.push(args) });
      return state;
    };
    const preselect = [{ id: agent.uid, username: agent.name, displayName: agent.name, accountType: "agent" }];
    assert.match(await render(Dialog, { session, directoryAgents: [agent] }), /im-search-agents/);
    state!.title.value = "Test group";
    state!.selected.value = preselect;
    await state!.create();
    assert.deepEqual(writes[0].body, { title: "Test group", memberUids: [37] });
    assert.deepEqual(events.at(-1), ["created", group]);
    await render(Dialog, { session, group, directoryAgents: [agent], preselect });
    await state!.addMembers();
    assert.match(writes[1].path, /\/groups\/8\/members$/);
    assert.deepEqual(writes[1].body, { memberUids: [37] });
    assert.deepEqual(state!.selected.value, []);
    assert.deepEqual(state!.members.value, [member]);
    assert.deepEqual(events.at(-1), ["changed"]);
    Dialog.setup = (props, context) => {
      const bindings = original(props, context);
      bindings.members.value = [member];
      bindings.loading.value = false;
      return bindings;
    };
    const html = await render(Dialog, { session, group });
    assert.match(html, /src="https:\/\/example.test\/avatar.png"/);
    assert.match(html, /data-testid="im-member-agent-badge">智能体/);
    assert.match(html, /im-member-profile/);
  } finally {
    // The dialog's immediate membership watch also resolves profile names.
    // Let those mocked requests settle before restoring the real fetch.
    await new Promise((resolve) => setTimeout(resolve, 20));
    globalThis.fetch = originalFetch;
    resetNames();
  }
});

test("new group agents feed the mention picker and encode their UID for group dispatch", () => {
  const app = readFileSync("src/App.vue", "utf8");
  assert.match(app, /:directory-agents="directoryAgents"/);
  assert.match(app, /activeGroupMembers\.value\.filter\(\(member\) => member\.accountType === "agent"\)/);
  assert.match(app, /const mentionSuggestions = computed[\s\S]*?activeAgents\.value\.filter/);
  assert.match(app, /async function groupChanged[\s\S]*?loadActiveGroupMembers/);
  assert.match(app, /function insertMention[\s\S]*?String\(agent\.uid\)/);
  const content = buildOutgoingText("@Test agent reply", ChannelTypeGroup, [String(member.uid)]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(content.encode())).mention, { uids: ["37"] });
});

// UNI-IM-REDESIGN: distinct rail tabs, the agent directory, agent search.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { listAgents, matchAgents, uncontactedAgents, type DirectoryAgent } from "../src/agents.ts";
import { loadComponent, render } from "./render.ts";

const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
const hr: DirectoryAgent = { uid: 50, name: "HR helper", description: "Answers leave and payroll questions" };
const ops: DirectoryAgent = { uid: 51, name: "Ops bot", description: "" };

test("listAgents: GET /api/v1/im/agents with the session; any failure is an empty directory", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  try {
    globalThis.fetch = async (url, init) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ code: 0, data: [hr] }), { status: 200 });
    };
    assert.deepEqual(await listAgents(session), [hr]);
    assert.match(calls[0].url, /\/api\/v1\/im\/agents$/);
    assert.deepEqual(calls[0].init?.headers, { Authorization: "j" });
    globalThis.fetch = async () => new Response("404 page not found", { status: 404 });
    assert.deepEqual(await listAgents(session), [], "older im without the route");
    globalThis.fetch = async () => { throw new TypeError("network"); };
    assert.deepEqual(await listAgents(session), []);
  } finally {
    globalThis.fetch = original;
  }
});

test("matchAgents: name, resolved nickName or description contains the query; 2-char minimum", () => {
  assert.deepEqual(matchAgents([hr, ops], "payroll"), [hr], "description, mid-string");
  assert.deepEqual(matchAgents([hr, ops], "BOT"), [ops], "case-insensitive");
  assert.deepEqual(matchAgents([hr, ops], "人事", (uid) => uid === "50" ? "人事助手" : ""), [hr], "resolved nickName");
  assert.deepEqual(matchAgents([hr, ops], "h"), []);
});

test("uncontactedAgents: directory agents without a conversation, by name", () => {
  assert.deepEqual(uncontactedAgents([ops, hr], []), [hr, ops]);
  assert.deepEqual(uncontactedAgents([ops, hr], ["50"]), [ops]);
});

test("search: matching agents get their own section above people, and choosing one emits agent", async () => {
  const Picker = await loadComponent("src/components/ContactPicker.vue") as { setup: (...a: unknown[]) => Record<string, unknown> };
  const emitted: unknown[][] = [];
  const original = Picker.setup;
  let bindings: Record<string, unknown> = {};
  Picker.setup = function (this: unknown, props: unknown, ctx: Record<string, unknown>) {
    bindings = original.call(this, props, { ...ctx, emit: (...args: unknown[]) => emitted.push(args) });
    (bindings.query as { value: string }).value = "payroll";
    return bindings;
  };
  try {
    const html = await render(Picker, { session, agents: [hr, ops] }, "zh");
    assert.match(html, /data-testid="im-search-agents"[\s\S]*智能体[\s\S]*HR helper[\s\S]*Answers leave and payroll questions/);
    assert.doesNotMatch(html, /Ops bot/);
    assert.doesNotMatch(html, /没有匹配/, "an agent hit is not a zero-result search");
    (bindings.chooseAgent as (a: DirectoryAgent) => void)(hr);
    assert.deepEqual(emitted.find((e) => e[0] === "agent"), ["agent", hr]);
  } finally {
    Picker.setup = original;
  }
});

const app = readFileSync("src/App.vue", "utf8");

test("App: the directory loads per session and feeds the Agents tab, agent tagging and search", () => {
  assert.match(app, /listAgents\(nextSession\)\.then\(\(agents\) => \{\s*if \(session\.value\?\.uid === nextSession\.uid\) directoryAgents\.value = agents;/);
  assert.match(app, /directoryAgents\.value = \[\];/, "teardown drops one account's directory");
  assert.match(app, /\.\.\.directoryAgents\.value\.map\(\(agent\) => String\(agent\.uid\)\)/, "directory uids count as agents");
  assert.match(app, /const unopenedAgents = computed\(\(\) => railMode\.value !== "agents" \? \[\] : uncontactedAgents\(/);
  assert.match(app, /v-for="agent in unopenedAgents"[\s\S]*?@click="openAgent\(agent\)"/);
  assert.match(app, /function openAgent\(agent: DirectoryAgent\): void \{\s*void openChannel\(new Channel\(String\(agent\.uid\), ChannelTypePerson\)\);/);
  // IM3-D5: the search page took over from the sidebar picker; agents still feed it and open the DM.
  assert.match(app, /<SearchPanel[\s\S]*?:agents="directoryAgents"[\s\S]*?@agent="\(agent\) => \{ searchOpen = false; openAgent\(agent\); \}"/);
});

test("App: each tab has its own empty state, and a phone rail tap closes the chat covering the list", () => {
  assert.match(app, /railMode === "groups" \? "empty\.noGroups" : railMode === "agents" \? "empty\.noAgents" : "empty\.noConversations"/);
  assert.match(app, /const unopenedGroups = computed\(\(\) => railMode\.value === "agents" \? \[\] :/);
  assert.equal(app.match(/@click="selectRail\('(all|groups|agents)'\)"/g)?.length, 3);
  assert.doesNotMatch(app, /@click="railMode = /);
  assert.match(app, /function selectRail[\s\S]*?matchMedia\("\(max-width: 720px\)"\)\.matches\) activeChannel\.value = undefined;/);
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /@media \(max-width: 720px\) \{\s*\.app-shell \{/, "same breakpoint as the one-screen phone layout");
});

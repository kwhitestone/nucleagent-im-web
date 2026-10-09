// IM1 (Q3 D3, A1–A5): conversation rows show the resolved avatar, else the
// initial; groups get their name's initial on a per-group tint instead of "#".
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import type { ConnectSession } from "../src/api.ts";
import { avatarFailed, avatarRetryMs, avatarSrc, ensureNames, resetNames } from "../src/names.ts";
import { loadComponent, render } from "./render.ts";

const me: ConnectSession = { uid: "1", token: "im", wsAddr: "ws://im", jwt: "jwt" };
const cs = (uid: number, v = "") => `https://cs.example/v0.1/download?dentryId=${uid}${v}`;

function stubResolve(avatarOf: (uid: number, round: number) => string) {
  const calls: number[][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (_input, init = {}) => {
    const { uids } = JSON.parse(String(init.body)) as { uids: number[] };
    calls.push(uids);
    const round = calls.length;
    const items = uids.map((uid) => ({ uid, profile: { nickName: `N${uid}`, avatar: avatarOf(uid, round), accountType: uid >= 900 ? "agent" : "human", provisioned: true } }));
    return new Response(JSON.stringify({ code: 0, message: "success", data: { items, degraded: false } }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = original; resetNames(); } };
}

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const withTimers = () => mock.timers.enable({ apis: ["setTimeout"] });

test("avatarSrc: only a safe https avatar is drawn (auth safeAvatar semantics); anything else is the initial", async () => {
  const f = stubResolve((uid) => ({ 30: cs(30), 31: "http://plain.example/x.png", 32: "javascript:alert(1)", 33: "", 36: 'https://x.example/a"onerror=1' } as Record<number, string>)[uid] ?? "");
  try {
    await ensureNames(["30", "31", "32", "33", "36"], me);
    assert.equal(avatarSrc("30"), cs(30));
    assert.equal(avatarSrc("31"), "", "http is not drawn");
    assert.equal(avatarSrc("32"), "");
    assert.equal(avatarSrc("33"), "", "no avatar: initial");
    assert.equal(avatarSrc("36"), "", "quotes are refused like safeAvatar does");
    assert.equal(avatarSrc("34", "https://member.example/34.png"), "https://member.example/34.png", "a stored (group member) https avatar still counts");
    assert.equal(avatarSrc("35", "http://member.example/35.png"), "");
  } finally { f.restore(); }
});

test("A4: failures show the initial at once, re-resolve once (batched), and draw the fresh URL", async () => {
  withTimers();
  const f = stubResolve((uid, round) => cs(uid, `&Expires=${round}`));
  try {
    await ensureNames(["50", "51", "52"], me);
    const first = avatarSrc("50");
    avatarFailed("50");
    avatarFailed("51");
    avatarFailed("50"); // the same broken image reporting twice is one retry
    assert.equal(avatarSrc("50"), "", "the initial while the recheck is in flight, never a broken image");
    assert.equal(avatarSrc("52"), cs(52, "&Expires=1"), "others unaffected");
    assert.equal(f.calls.length, 1, "not per row: waits for the batch window");
    mock.timers.tick(avatarRetryMs);
    await settle();
    assert.deepEqual(f.calls, [[50, 51, 52], [50, 51]], "one re-resolve for every failure in the window");
    assert.equal(avatarSrc("50"), cs(50, "&Expires=2"), "the fresh URL is drawn");
    assert.equal(avatarSrc("52"), cs(52, "&Expires=1"), "a uid that never failed is untouched");
    avatarFailed("50");
    assert.equal(avatarSrc("50"), "", "failed again: initial");
    mock.timers.tick(avatarRetryMs * 5);
    await settle();
    assert.equal(f.calls.length, 2, "re-resolved at most once per uid");
  } finally { f.restore(); mock.timers.reset(); }
});

test("A2: a 404 that stays 404 is retried once after the re-resolve, then the initial for good (no loop)", async () => {
  withTimers();
  const f = stubResolve(() => cs(404));
  try {
    await ensureNames(["40"], me);
    avatarFailed("40");
    assert.equal(avatarSrc("40"), "", "initial at once");
    mock.timers.tick(avatarRetryMs);
    await settle();
    assert.equal(f.calls.length, 2, "one re-resolve");
    assert.equal(avatarSrc("40"), cs(404), "same URL: tried once more (a one-off 403 recovers)");
    avatarFailed("40");
    assert.equal(avatarSrc("40"), "", "failed again: initial");
    avatarFailed("40");
    mock.timers.tick(avatarRetryMs * 5);
    await settle();
    assert.equal(f.calls.length, 2, "no further requests");
    assert.equal(avatarSrc("40"), "");
  } finally { f.restore(); mock.timers.reset(); }
});

test("A4: a re-resolve that fails outright still retries the old URL once, then the initial", async () => {
  withTimers();
  const f = stubResolve(() => cs(61));
  try {
    await ensureNames(["61"], me);
    const original = globalThis.fetch;
    globalThis.fetch = async () => new Response("{}", { status: 500 });
    avatarFailed("61");
    mock.timers.tick(avatarRetryMs);
    await settle();
    globalThis.fetch = original;
    assert.equal(avatarSrc("61"), cs(61));
    avatarFailed("61");
    assert.equal(avatarSrc("61"), "");
  } finally { f.restore(); mock.timers.reset(); }
});

test("an account switch forgets failures and pending re-resolves", async () => {
  withTimers();
  const f = stubResolve(() => cs(70));
  try {
    await ensureNames(["70"], me);
    avatarFailed("70");
    mock.timers.tick(avatarRetryMs);
    await settle();
    avatarFailed("70");
    assert.equal(avatarSrc("70"), "");
    resetNames();
    await ensureNames(["70"], me);
    assert.equal(avatarSrc("70"), cs(70));
  } finally { f.restore(); mock.timers.reset(); }
});

/** Renders RowAvatar and hands back its setup bindings, so a test can fire @error. */
async function rowAvatar(props: Record<string, unknown>) {
  const component = await loadComponent("src/components/RowAvatar.vue") as { setup: (p: unknown, c: unknown) => Record<string, unknown> };
  let bindings: Record<string, unknown> = {};
  const original = component.setup;
  component.setup = function (this: unknown, p: unknown, c: unknown) { bindings = original.call(this, p, c); return bindings; };
  try {
    return { html: await render(component, props), bindings };
  } finally { component.setup = original; }
}

test("A1 person/agent row: a lazy, no-referrer <img> when resolved; the initial otherwise", async () => {
  const f = stubResolve((uid) => uid === 81 ? "" : cs(uid));
  try {
    await ensureNames(["80", "81", "900"], me);
    const person = (await rowAvatar({ id: "80", name: "碧威" })).html;
    assert.match(person, /<img[^>]* src="https:\/\/cs\.example\/v0\.1\/download\?dentryId=80"/);
    assert.match(person, /<img[^>]* loading="lazy"/);
    assert.match(person, /<img[^>]* referrerpolicy="no-referrer"/);
    assert.match(person, /<img[^>]* alt[ =>]/, "decorative: empty alt");
    assert.doesNotMatch(person, />碧</, "no initial behind the image");
    const agent = (await rowAvatar({ id: "900", name: "helper", kind: "agent" })).html;
    assert.match(agent, /class="avatar bot"/);
    assert.match(agent, /<img[^>]* src="https:\/\/cs\.example\/v0\.1\/download\?dentryId=900"/);
    const none = (await rowAvatar({ id: "81", name: "kim" })).html;
    assert.doesNotMatch(none, /<img/);
    assert.match(none, />K</, "no avatar: the upper-cased initial");
    const resolving = (await rowAvatar({ id: "82", name: "", unnamed: true })).html;
    assert.match(resolving, /class="avatar unnamed"/);
    assert.doesNotMatch(resolving, /<img/);
  } finally { f.restore(); }
});

test("@error on the row image: retried once, then the row re-renders the initial", async () => {
  withTimers();
  const f = stubResolve((uid) => cs(uid));
  try {
    await ensureNames(["83"], me);
    const { html, bindings } = await rowAvatar({ id: "83", name: "Lin" });
    assert.match(html, /<img/);
    (bindings.failed as () => void)();
    mock.timers.tick(avatarRetryMs);
    await settle();
    assert.equal(f.calls.length, 2, "the row's @error triggered the one re-resolve");
    assert.match((await rowAvatar({ id: "83", name: "Lin" })).html, /<img/, "redrawn after the re-resolve");
    (bindings.failed as () => void)();
    const after = (await rowAvatar({ id: "83", name: "Lin" })).html;
    assert.doesNotMatch(after, /<img/);
    assert.match(after, />L</);
    assert.match(readFileSync("src/components/RowAvatar.vue", "utf8"), /<img[^>]*@error="failed"/);
  } finally { f.restore(); mock.timers.reset(); }
});

test("A1 group row: the group name's initial on a tint stable per group id, never '#' and never an image", async () => {
  const tint = (html: string) => html.match(/style="background:\s*([^";]+)/)?.[1];
  const a = (await rowAvatar({ id: "g_101", name: "验收群", kind: "group" })).html;
  const renamed = (await rowAvatar({ id: "g_101", name: "改名了", kind: "group" })).html;
  assert.match(a, /class="avatar group"/);
  assert.match(a, />验</);
  assert.doesNotMatch(a, /#|<img/);
  assert.ok(tint(a)?.startsWith("var(--grad-"), "a palette tint");
  assert.equal(tint(renamed), tint(a), "same group id, same tint (a rename keeps the colour)");
  const tints = new Set<string | undefined>();
  for (let i = 0; i < 24; i++) tints.add(tint((await rowAvatar({ id: `g_${i}`, name: "g", kind: "group" })).html));
  assert.ok(tints.size >= 4, `ids spread across the palette (${tints.size})`);
});

test("A5: rows never call the network; each page is one batched resolve of only the new uids", async () => {
  const f = stubResolve((uid) => cs(uid));
  try {
    const page1 = Array.from({ length: 50 }, (_, i) => String(100 + i));
    const page2 = Array.from({ length: 30 }, (_, i) => String(150 + i));
    await ensureNames(page1, me);
    for (const uid of page1) await rowAvatar({ id: uid, name: `N${uid}` });
    await ensureNames([...page1, ...page2], me);
    assert.deepEqual(f.calls.map((c) => c.length), [50, 30]);
  } finally { f.restore(); }
});

const app = readFileSync("src/App.vue", "utf8");

test("App wiring: conversation, unopened-group and unopened-agent rows all draw RowAvatar", () => {
  assert.match(app, /import RowAvatar from "\.\/components\/RowAvatar\.vue";/);
  const list = app.slice(app.indexOf('<nav class="conversation-list"'), app.indexOf("</nav>", app.indexOf('<nav class="conversation-list"')));
  assert.equal(list.match(/<RowAvatar/g)?.length, 3);
  assert.doesNotMatch(list, /<span class="avatar/, "no bare initial spans left in the list");
  assert.doesNotMatch(list, />#</);
  assert.match(list, /<RowAvatar\s+:id="conversation\.channel\.channelID"\s+:name="conversationTitle\(conversation\)"\s+:kind="conversationKind\(conversation\)"\s+:unnamed="isResolving\(conversation\)"/);
  assert.match(list, /<RowAvatar :id="group\.wukongChannelId" :name="group\.title" kind="group" \/>/);
  assert.match(list, /<RowAvatar :id="String\(agent\.uid\)" :name="agentRowName\(agent\)" kind="agent" \/>/);
  assert.match(app, /function conversationKind\(conversation: Conversation\)[\s\S]*?ChannelTypeGroup\) return "group";[\s\S]*?isAgentConversation\(conversation\) \? "agent" : "person"/);
});

test("App wiring: message avatars share the same https filter and failure handling", () => {
  assert.match(app, /function messageAvatar\(message: Message\): string \{[\s\S]*?avatarSrc\(message\.fromUID, member\?\.avatar\)/);
  assert.match(app, /@error="avatarFailed\(message\.fromUID, messageAvatar\(message\)\)"/);
  assert.doesNotMatch(app, /avatarLoadFailed/);
});

test("A3 CSS: any avatar image fills and is clipped by its shape, never stretched", () => {
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /\n\.avatar \{\s*overflow: hidden;\s*\}/);
  assert.match(css, /\.avatar img \{[^}]*width: 100%;[^}]*height: 100%;[^}]*object-fit: cover;/);
  assert.match(css, /\.conversation \.avatar:not\(\.bot\) \{\s*border-radius: var\(--r-full\);/, "phone: people stay round");
});

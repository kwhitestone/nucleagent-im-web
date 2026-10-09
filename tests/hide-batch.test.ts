// IM3-D4 (Q3 §2, §6 H1–H8 front end): hide / unhide / mark-read on many conversations,
// the hidden view, the 5 s undo, selection that survives paging, partial failures.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { shallowRef } from "vue";
import { Channel, ChannelTypeGroup, ChannelTypePerson, Conversation, Message, WKSDK } from "wukongimjssdk";
import { batchConversations, batchLimit, channelKey, channelOfKey, loadHiddenConversations, undoMs, useConversationBatch } from "../src/hiding.ts";
import { loadConversationPage } from "../src/im.ts";
import zh from "../src/i18n/zh.ts";

after(() => clearInterval((WKSDK.shared().receiptManager as unknown as { timer: ReturnType<typeof setInterval> }).timer));
const app = readFileSync("src/App.vue", "utf8");
const session = { uid: "11", token: "t", wsAddr: "ws://im", jwt: "jwt" };

type Call = { url: string; body: Record<string, any> };
function stubFetch(reply: (call: Call) => unknown) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), body: JSON.parse(String(init.body || "{}")) };
    calls.push(call);
    const value = reply(call);
    if (value instanceof Error) throw value;
    if (typeof value === "number") return new Response("{}", { status: value });
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

/** The im batch endpoint: ok for every channel in `own`, not_found otherwise (H8: someone else's). */
function batchServer(own: Set<string>) {
  return ({ url, body }: Call) => {
    assert.match(url, /\/api\/v1\/im\/conversation\/batch$/);
    return { results: body.channels.map((c: any) => ({ channel_id: c.channel_id, channel_type: c.channel_type, ok: own.has(`${c.channel_type}:${c.channel_id}`), code: own.has(`${c.channel_type}:${c.channel_id}`) ? "" : "not_found" })) };
  };
}

function conv(id: string, ts: number, type = ChannelTypeGroup, unread = 0): Conversation {
  const c = new Conversation();
  c.channel = new Channel(id, type);
  c.timestamp = ts;
  c.unread = unread;
  return c;
}

const t = (key: string, params: Record<string, unknown> = {}) => `${key}${JSON.stringify(params)}`;
function setup(list: Conversation[]) {
  const conversations = shallowRef(list);
  const hiddenEvents: string[][] = [];
  const batch = useConversationBatch({ session: () => session, conversations, t, onHidden: (keys) => hiddenEvents.push(keys) });
  return { conversations, batch, hiddenEvents };
}
const keys = (list: Conversation[]) => list.map((c) => channelKey(c.channel));
const sorted = (list: Conversation[]) => keys([...list].sort((a, b) => b.timestamp - a.timestamp));

test("channel keys round-trip, including person channels whose id holds a colon-free uid", () => {
  assert.equal(channelKey(new Channel("g1", ChannelTypeGroup)), "2:g1");
  const back = channelOfKey("1:12");
  assert.equal(back.channelID, "12");
  assert.equal(back.channelType, ChannelTypePerson);
});

test("H6/H8: one batch call, per-channel results; not_found (another user's channel) is a failure", async () => {
  const stub = stubFetch(batchServer(new Set(["2:g1"])));
  try {
    const out = await batchConversations("hide", ["2:g1", "1:999", "2:g1"], session);
    assert.deepEqual(out, { ok: ["2:g1"], failed: ["1:999"] });
    assert.equal(stub.calls.length, 1);
    assert.deepEqual(stub.calls[0].body, { action: "hide", channels: [{ channel_id: "g1", channel_type: 2 }, { channel_id: "999", channel_type: 1 }] }, "duplicates are sent once");
  } finally { stub.restore(); }
});

test("more than 100 channels go out in chunks of ≤100 and the results merge; a failed chunk fails only its own keys", async () => {
  const all = Array.from({ length: 230 }, (_, i) => `2:g${i}`);
  let n = 0;
  const stub = stubFetch((call) => (++n === 2 ? 500 : batchServer(new Set(all))(call)));
  try {
    const out = await batchConversations("read", all, session);
    assert.equal(batchLimit, 100);
    assert.deepEqual(stub.calls.map((c) => c.body.channels.length), [100, 100, 30]);
    assert.deepEqual(out.failed, all.slice(100, 200), "the 500 chunk is failed, the rest is not lost");
    assert.deepEqual(out.ok, [...all.slice(0, 100), ...all.slice(200)]);
  } finally { stub.restore(); }
});

test("the hidden view lists {hidden:true} pages until done; the default list sends no flag", async () => {
  const row = (id: string) => ({ channel_id: id, channel_type: 2, unread: 0, active_at: 1 });
  const stub = stubFetch(({ body }) => body.hidden
    ? (body.cursor ? { conversations: [row("h2")], done: true } : { conversations: [row("h1")], next_cursor: "7", done: false })
    : { conversations: [row("v1")], done: true });
  try {
    const hidden = await loadHiddenConversations(session);
    assert.deepEqual(keys(hidden), ["2:h1", "2:h2"]);
    await loadConversationPage(session);
    assert.deepEqual(stub.calls.map((c) => c.body), [{ hidden: true }, { hidden: true, cursor: "7" }, {}]);
  } finally { stub.restore(); }
});

test("H1: hide removes the row, it shows in the hidden view with unread cleared; unhide puts it back in place", async () => {
  const list = [conv("a", 30), conv("b", 20, ChannelTypeGroup, 4), conv("c", 10)];
  const { conversations, batch, hiddenEvents } = setup(list);
  const before = sorted(conversations.value);
  const stub = stubFetch(batchServer(new Set(keys(list))));
  try {
    await batch.run("hide", ["2:b"]);
    assert.deepEqual(keys(conversations.value), ["2:a", "2:c"]);
    assert.deepEqual(keys(batch.hidden.value), ["2:b"]);
    assert.equal(batch.hidden.value[0].unread, 0, "hide clears unread like the server does");
    assert.ok(batch.hiddenKeys.value.has("2:b"));
    assert.deepEqual(hiddenEvents, [["2:b"]], "the app drops it from the SDK cache too");
    await batch.run("unhide", ["2:b"]);
    assert.equal(batch.notice.value?.undo, undefined, "only hide offers undo");
    assert.deepEqual(batch.hidden.value, []);
    assert.deepEqual(sorted(conversations.value), before, "back at its original position");
  } finally { stub.restore(); batch.reset(); }
});

test("H4: multi-select 5 of 6 → hide without a confirm → toast offers undo → undo unhides the same 5", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const list = Array.from({ length: 6 }, (_, i) => conv(`g${i}`, 100 - i));
  const { conversations, batch } = setup(list);
  const stub = stubFetch(batchServer(new Set(keys(list))));
  try {
    batch.startSelecting();
    for (const key of keys(list).slice(0, 5)) batch.toggle(key);
    assert.equal(batch.selected.value.size, 5);
    await batch.runSelected("hide");
    assert.deepEqual(keys(conversations.value), ["2:g5"]);
    assert.equal(batch.selecting.value, false, "all done: the select bar closes");
    assert.equal(batch.notice.value?.text, 'hide.doneHide{"count":5}');
    assert.ok(batch.notice.value?.undo, "hide offers undo");
    await batch.undo();
    assert.deepEqual(stub.calls.map((c) => c.body.action), ["hide", "unhide"]);
    assert.deepEqual(stub.calls[1].body.channels, stub.calls[0].body.channels, "undo = unhide of the same batch");
    assert.deepEqual(sorted(conversations.value), keys(list));
  } finally { stub.restore(); batch.reset(); mock.timers.reset(); }
});

test("the undo offer lasts 5 s, then the toast goes and nothing is unhidden", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const { batch } = setup([conv("a", 1)]);
  const stub = stubFetch(batchServer(new Set(["2:a"])));
  try {
    await batch.run("hide", ["2:a"]);
    assert.equal(undoMs, 5000);
    mock.timers.tick(undoMs - 1);
    assert.ok(batch.notice.value?.undo);
    mock.timers.tick(1);
    assert.equal(batch.notice.value, undefined);
    await batch.undo();
    assert.equal(stub.calls.length, 1, "an expired undo does nothing");
  } finally { stub.restore(); batch.reset(); mock.timers.reset(); }
});

test("H5: selection is by channelKey, so picks on page 1 survive loading page 2; select-all adds only loaded rows", async () => {
  const page1 = Array.from({ length: 50 }, (_, i) => conv(`p1-${i}`, 1000 - i));
  const page2 = Array.from({ length: 10 }, (_, i) => conv(`p2-${i}`, 500 - i));
  const { conversations, batch } = setup(page1);
  const stub = stubFetch(batchServer(new Set(keys([...page1, ...page2]))));
  try {
    batch.startSelecting("2:p1-0");
    batch.toggle("2:p1-1");
    conversations.value = [...conversations.value, ...page2]; // scrolled: next page appended
    batch.toggle("2:p2-0");
    batch.toggle("2:p2-1");
    batch.toggle("2:p2-1");
    batch.toggle("2:p2-1");
    assert.equal(batch.selected.value.size, 4);
    await batch.runSelected("hide");
    assert.deepEqual(stub.calls[0].body.channels.map((c: any) => c.channel_id), ["p1-0", "p1-1", "p2-0", "p2-1"]);
    assert.equal(conversations.value.length, 56);
    batch.startSelecting("2:elsewhere"); // picked before a filter change, not on screen now
    batch.selectAll(keys(conversations.value));
    assert.equal(batch.selected.value.size, 57, "select-all adds to the selection, it does not replace it");
  } finally { stub.restore(); batch.reset(); }
});

test("H6/H8: partial failure says 成功 x、失败 y, keeps the failures selected, and a retry sends only them", async () => {
  const list = [conv("a", 3), conv("b", 2), conv("c", 1)];
  const { conversations, batch } = setup(list);
  const own = new Set(["2:a", "2:b"]);
  const stub = stubFetch(batchServer(own));
  try {
    batch.startSelecting();
    batch.selectAll(keys(list));
    await batch.runSelected("hide");
    assert.equal(batch.notice.value?.text, 'hide.partial{"ok":2,"failed":1}');
    assert.ok(batch.notice.value?.undo, "the part that worked can still be undone");
    assert.equal(batch.selecting.value, true);
    assert.deepEqual([...batch.selected.value], ["2:c"]);
    assert.deepEqual(keys(conversations.value), ["2:c"], "the failed row stays in the list");
    own.add("2:c");
    await batch.runSelected("hide");
    assert.deepEqual(stub.calls[1].body.channels, [{ channel_id: "c", channel_type: 2 }]);
    assert.equal(batch.selecting.value, false);
  } finally { stub.restore(); batch.reset(); }
});

test("a whole-request failure (old im: 404) is all failed, nothing moves", async () => {
  const { conversations, batch } = setup([conv("a", 1)]);
  const stub = stubFetch(() => 404);
  try {
    await batch.run("hide", ["2:a"]);
    assert.equal(conversations.value.length, 1);
    assert.equal(batch.notice.value?.text, 'hide.partial{"ok":0,"failed":1}');
    assert.equal(batch.notice.value?.undo, undefined);
  } finally { stub.restore(); batch.reset(); }
});

test("mark read clears unread locally for the ok ones only; no undo offered", async () => {
  const list = [conv("a", 2, ChannelTypeGroup, 3), conv("b", 1, ChannelTypeGroup, 5)];
  const { conversations, batch } = setup(list);
  const stub = stubFetch(batchServer(new Set(["2:a"])));
  try {
    await batch.run("read", ["2:a", "2:b"]);
    assert.deepEqual(conversations.value.map((c) => c.unread), [0, 5]);
    assert.equal(batch.notice.value?.undo, undefined);
  } finally { stub.restore(); batch.reset(); }
});

test("H3: a pushed message from someone else brings a hidden row back; the viewer's own message does not", async () => {
  const { batch } = setup([conv("x", 1, ChannelTypePerson), conv("y", 1, ChannelTypePerson)]);
  const stub = stubFetch(batchServer(new Set(["1:x", "1:y"])));
  try {
    await batch.run("hide", ["1:x", "1:y"]);
    const incoming = (id: string, from: string) => {
      const c = conv(id, 9, ChannelTypePerson, 1);
      c.lastMessage = Object.assign(new Message(), { fromUID: from });
      return c;
    };
    assert.equal(batch.receive(incoming("x", "12"), session.uid), true);
    assert.ok(!batch.hiddenKeys.value.has("1:x"));
    assert.equal(batch.receive(incoming("y", session.uid), session.uid), false, "server keeps it hidden too (messages.go)");
    assert.ok(batch.hiddenKeys.value.has("1:y"));
    assert.equal(batch.receive(incoming("z", "12"), session.uid), true, "not hidden: shown as before");
  } finally { stub.restore(); batch.reset(); }
});

test("refreshHidden on an old im (422 on {hidden:true}) leaves an empty hidden view instead of an error", async () => {
  const { batch } = setup([]);
  const stub = stubFetch(() => 422);
  try {
    await batch.refreshHidden();
    assert.deepEqual(batch.hidden.value, []);
  } finally { stub.restore(); batch.reset(); }
});

// ---- App.vue wiring (the suite renders no SDK-driven App; it pins the call sites).
test("entries: row ⋯ button, right-click, 500 ms long-press, chat-header hide, list-header select + hidden view", () => {
  const list = app.slice(app.indexOf('<nav class="conversation-list"'), app.indexOf("</nav>", app.indexOf('<nav class="conversation-list"')));
  assert.match(list, /@contextmenu\.prevent="openRowMenu\(conversation, \$event\)"/);
  assert.match(list, /@pointerdown="pressStart\(conversation, \$event\)"/);
  assert.match(list, /class="row-more"[\s\S]*?@click\.stop="openRowMenu\(conversation, \$event\)"/);
  assert.match(app, /const longPressMs = 500;/);
  assert.match(app, /data-testid="im-chat-menu"/);
  assert.match(app, /data-testid="im-select-start"/);
  assert.match(app, /data-testid="im-hidden-entry"[\s\S]*?t\("hide\.hiddenList", \{ count: batch\.hidden\.value\.length \}\)/);
  assert.match(app, /data-testid="im-hidden-view"[\s\S]*?data-testid="im-unhide"/);
  assert.match(app, /data-testid="im-select-bar"[\s\S]*?selectAll[\s\S]*?runSelected\('hide'\)[\s\S]*?runSelected\('read'\)[\s\S]*?stopSelecting/);
  assert.match(app, /data-testid="im-undo"/);
});

test("phones keep the list ⋯ menu: it is not inside a span (.sidebar-header span is hidden ≤720px)", () => {
  const header = app.slice(app.indexOf('<header class="sidebar-header">'), app.indexOf("</header>", app.indexOf('<header class="sidebar-header">')));
  const at = header.indexOf('data-testid="im-list-menu"');
  assert.ok(at > 0);
  const open = (tag: string) => (header.slice(0, at).match(new RegExp(`<${tag}[\\s>]`, "g")) || []).length - (header.slice(0, at).match(new RegExp(`</${tag}>`, "g")) || []).length;
  assert.equal(open("span"), 0, "no open <span> around the ⋯ button");
  assert.match(readFileSync("src/style.css", "utf8"), /@media \(max-width: 720px\)[\s\S]*?\.sidebar-header span \{\s*display: none;/);
});

test("Esc leaves select mode (and closes an open menu first)", () => {
  const esc = app.slice(app.indexOf("function onKeydown"), app.indexOf("function onVisible"));
  assert.match(esc, /Escape/);
  assert.match(esc, /menu\.value[\s\S]*?stopSelecting\(\)/);
  assert.match(app, /document\.addEventListener\("keydown", onKeydown\)/);
});

test("H7: coming back to the tab re-pulls the first page and the hidden list; so does a reconnect", () => {
  assert.match(app, /document\.addEventListener\("visibilitychange", onVisible\)/);
  assert.match(app, /document\.removeEventListener\("visibilitychange", onVisible\)/);
  const visible = app.slice(app.indexOf("function onVisible"), app.indexOf("function onVisible") + 300);
  assert.match(visible, /visibilityState === "visible"[\s\S]*?syncConversations\(\)[\s\S]*?batch\.refreshHidden\(\)/);
  const status = app.slice(app.indexOf("const connectStatusListener"), app.indexOf("const conversationListener"));
  assert.match(status, /batch\.refreshHidden\(\)/);
});

test("a pushed conversation goes through receive(); hidden rows never reappear as 'unopened' groups or agents", () => {
  const listener = app.slice(app.indexOf("const conversationListener"), app.indexOf("const messageListener"));
  assert.match(listener, /if \(!batch\.receive\(conversation, session\.value\?\.uid \|\| ""\)\) return;/);
  const groups = app.slice(app.indexOf("const unopenedGroups"), app.indexOf("const unopenedAgents"));
  assert.match(groups, /batch\.hiddenKeys\.value\.has/);
  const agents = app.slice(app.indexOf("const unopenedAgents"), app.indexOf("function agentDescription"));
  assert.match(agents, /batch\.hiddenKeys\.value/);
});

test("search results tag hidden chats 已隐藏; the session teardown resets hiding state", () => {
  // IM3-D5: search moved to SearchPanel, which gets hidden conversations and their keys.
  assert.match(app, /<SearchPanel[\s\S]*?:conversations="searchableConversations"[\s\S]*?:hidden-keys="batch\.hiddenKeys\.value"/);
  assert.match(app, /const searchableConversations = computed\(\(\) => \[\.\.\.conversations\.value, \.\.\.batch\.hidden\.value\]\)/);
  assert.equal(zh.hide.tag, "已隐藏");
  const teardown = app.slice(app.indexOf("function teardownSession"), app.indexOf("function openAccount"));
  assert.match(teardown, /batch\.reset\(\)/);
});

test("select mode: a row click toggles instead of opening, with role=checkbox state", () => {
  assert.match(app, /function rowClicked\(conversation: Conversation\)[\s\S]*?batch\.selecting\.value[\s\S]*?batch\.toggle\(channelKey\(conversation\.channel\)\)[\s\S]*?openChannel\(conversation\.channel\)/);
  assert.match(app, /:role="batch\.selecting\.value \? 'checkbox' : undefined"/);
  assert.match(app, /:aria-checked="batch\.selecting\.value \? batch\.selected\.value\.has\(channelKey\(conversation\.channel\)\) : undefined"/);
});

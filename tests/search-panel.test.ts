// IM3-D5 (Q3 §5, §6 S1–S7 front end, U1–U2): the search page.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Channel, ChannelTypeGroup, ChannelTypePerson, Conversation } from "wukongimjssdk";
import {
  clearRecentSearches,
  loadRecentSearches,
  markSegments,
  messageSearch,
  queryMode,
  rememberSearch,
  titleMatch,
  countLabel,
} from "../src/search.ts";
import { loadComponent, render } from "./render.ts";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";

const app = readFileSync("src/App.vue", "utf8");
const panelSource = readFileSync("src/components/SearchPanel.vue", "utf8");
const session = { uid: "11", token: "t", wsAddr: "ws://im", jwt: "jwt" };

function stubFetch(reply: (url: string) => unknown) {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    const value = reply(String(input));
    if (value instanceof Error) throw value;
    if (typeof value === "number") return new Response(JSON.stringify({ code: value, message: "nope" }), { status: value });
    return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { urls, restore: () => { globalThis.fetch = original; } };
}

const storage = new Map<string, string>();
globalThis.localStorage = {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
} as Storage;

test("S5/U: query modes — empty is idle, one character is local-only (im refuses it), 2–64 searches everything", () => {
  assert.equal(queryMode(""), "idle");
  assert.equal(queryMode("   "), "idle");
  assert.equal(queryMode("碧"), "single");
  assert.equal(queryMode(" a "), "single");
  assert.equal(queryMode("蓝鲸"), "full");
  assert.equal(queryMode("x".repeat(64)), "full");
  assert.equal(queryMode("x".repeat(65)), "tooLong");
});

test("S1/S7: message and file search call GET /api/v1/im/search with q, type and cursor, and read the page", async () => {
  const stub = stubFetch(() => ({ messages: [{ message_idstr: "9", message_seq: 41, channel_id: "g1", channel_type: 2, from_uid: "12", payload_type: 1, timestamp: 5, hidden: true, snippet: "x 蓝鲸 y", snippet_html: "x <mark>蓝鲸</mark> y", ranges: [[2, 4]] }], total: 1, next_cursor: "" }));
  try {
    const page = await messageSearch(" 蓝鲸 ", "file", session, "77");
    const url = new URL(stub.urls[0]);
    assert.equal(url.pathname, "/api/v1/im/search");
    assert.equal(url.searchParams.get("q"), "蓝鲸", "trimmed");
    assert.equal(url.searchParams.get("type"), "file");
    assert.equal(url.searchParams.get("cursor"), "77");
    assert.equal(page.total, 1);
    assert.equal(page.hits[0].seq, 41);
    assert.equal(page.hits[0].hidden, true);
    assert.equal(page.hits[0].channel.channelID, "g1");
    assert.equal(page.hits[0].channel.channelType, ChannelTypeGroup);
  } finally { stub.restore(); }
});

test("S7: a failed search throws (the panel shows its error state with retry)", async () => {
  const stub = stubFetch(() => new TypeError("Failed to fetch"));
  try {
    await assert.rejects(messageSearch("蓝鲸", "message", session));
  } finally { stub.restore(); }
  const stub2 = stubFetch(() => 503);
  try {
    await assert.rejects(messageSearch("蓝鲸", "message", session));
  } finally { stub2.restore(); }
});

test("XSS: highlighting is built from the plain snippet and ranges — markup in a message stays text", () => {
  const snippet = `<img src=x onerror=alert(1)> 蓝鲸 & "q"`;
  const segments = markSegments(snippet, [[29, 31]]);
  assert.deepEqual(segments, [
    { text: `<img src=x onerror=alert(1)> `, hit: false },
    { text: "蓝鲸", hit: true },
    { text: ` & "q"`, hit: false },
  ]);
  assert.equal(segments.map((s) => s.text).join(""), snippet, "nothing dropped or added");
});

test("ranges are characters, not UTF-16 units; bad ranges are ignored instead of throwing", () => {
  const snippet = "😀蓝鲸ABC";
  assert.deepEqual(markSegments(snippet, [[1, 3]]), [{ text: "😀", hit: false }, { text: "蓝鲸", hit: true }, { text: "ABC", hit: false }]);
  assert.deepEqual(markSegments("abc", [[5, 9], [2, 1]]), [{ text: "abc", hit: false }]);
  assert.deepEqual(markSegments("abcabc", [[0, 1], [3, 4]]).filter((s) => s.hit).map((s) => s.text), ["a", "a"]);
});

test("S3/S5: local title match is case-insensitive, finds the middle of a name and works for one character", () => {
  assert.deepEqual(titleMatch("验收Q3蓝鲸ABC", "鲸a"), [[5, 7]]);
  assert.deepEqual(titleMatch("碧水蓝天", "碧"), [[0, 1]]);
  assert.equal(titleMatch("abc", "zz"), undefined);
  assert.equal(titleMatch("abc", ""), undefined);
});

test("recent searches: per account, newest first, deduped, at most 10, clearable", () => {
  storage.clear();
  for (let i = 0; i < 12; i++) rememberSearch("11", `q${i}`);
  rememberSearch("11", "q5");
  rememberSearch("11", " ");
  const list = loadRecentSearches("11");
  assert.equal(list.length, 10);
  assert.equal(list[0], "q5");
  assert.equal(list.filter((q) => q === "q5").length, 1);
  assert.deepEqual(loadRecentSearches("12"), [], "another account sees none");
  clearRecentSearches("11");
  assert.deepEqual(loadRecentSearches("11"), []);
  storage.set("nucleagent_im_recent_search:11", "{broken");
  assert.deepEqual(loadRecentSearches("11"), [], "corrupt storage is ignored");
});

test("counts: the server caps total at 100, shown as 99+", () => {
  assert.equal(countLabel(0), "0");
  assert.equal(countLabel(7), "7");
  assert.equal(countLabel(99), "99");
  assert.equal(countLabel(100), "99+");
});

// ---- the panel (SSR render of its idle/empty states; behaviour is pinned in source)
const Panel = await loadComponent("src/components/SearchPanel.vue");
const conv = (id: string, type: number) => Object.assign(new Conversation(), { channel: new Channel(id, type), timestamp: 1, unread: 0 });

test("U2: the panel never uses v-html; hits render as <mark> elements", () => {
  assert.doesNotMatch(panelSource, /v-html/);
  assert.match(panelSource, /<mark v-if="segment\.hit">\{\{ segment\.text \}\}<\/mark>/);
});

test("U2 idle: recent searches with a clear button; placeholder no longer promises UID search", async () => {
  storage.clear();
  rememberSearch("11", "蓝鲸");
  const html = await render(Panel, { session, conversations: [], hiddenKeys: new Set(), agents: [], titleFor: () => "" });
  assert.match(html, /data-testid="im-search-recent"/);
  assert.match(html, /蓝鲸/);
  assert.match(html, /data-testid="im-search-clear-recent"/);
  for (const copy of [zh.search.panelPlaceholder, en.search.panelPlaceholder, zh.list.searchPlaceholder, en.list.searchPlaceholder]) {
    assert.doesNotMatch(copy, /UID/i, copy);
  }
});

test("U1: tabs all / conversations / contacts / agents / messages / files with counts, Tab cycles them", () => {
  for (const tab of ["all", "conversations", "contacts", "agents", "messages", "files"]) {
    assert.match(panelSource, new RegExp(`"${tab}"`));
    assert.ok((zh.search.tabs as Record<string, string>)[tab] && (en.search.tabs as Record<string, string>)[tab], tab);
  }
  assert.match(panelSource, /role="tablist"/);
  assert.match(panelSource, /aria-selected/);
  assert.match(panelSource, /event\.key === "Tab"[\s\S]*?event\.preventDefault\(\)/);
  assert.match(panelSource, /event\.key === "ArrowDown"[\s\S]*?event\.key === "ArrowUp"[\s\S]*?event\.key === "Enter"[\s\S]*?event\.key === "Escape"/);
});

test("S5: one character never calls im search; it shows the rule and local title matches", () => {
  assert.match(panelSource, /mode\.value === "full"[\s\S]*?messageSearch\(/);
  assert.match(panelSource, /t\("search\.singleChar"\)/);
  assert.ok(zh.search.singleChar.includes("2"), "the hint names the 2-character rule");
});

test("S7/U2: loading skeleton, empty state with the rules, error state with retry", () => {
  assert.match(panelSource, /data-testid="im-search-skeleton"/);
  assert.match(panelSource, /data-testid="im-search-empty"[\s\S]*?t\("search\.emptyRules"\)/);
  assert.match(panelSource, /data-testid="im-search-error"[\s\S]*?@click="retry"/);
});

test("hidden conversations are in the results with the 已隐藏 tag (D4)", () => {
  assert.match(panelSource, /hiddenKeys\.has\(/);
  assert.ok((panelSource.match(/t\("hide\.tag"\)/g) || []).length >= 2, "conversation and message rows");
  assert.match(panelSource, /hit\.hidden/);
});

test("badges never wrap into a vertical stack; one scroll container", () => {
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /\.search-panel \.account-badge,[\s\S]*?white-space: nowrap;[\s\S]*?flex-shrink: 0;/);
  assert.match(css, /\.search-results \{[\s\S]*?overflow-y: auto;/);
});

// ---- App wiring
test("U1: Ctrl/⌘+K and / open the panel (not while typing); the rail search button opens it", () => {
  const keys = app.slice(app.indexOf("function onKeydown"), app.indexOf("function onKeydown") + 900);
  assert.match(keys, /\(event\.ctrlKey \|\| event\.metaKey\) && event\.key\.toLowerCase\(\) === "k"/);
  assert.match(keys, /event\.key === "\/" && !typing/);
  assert.match(app, /function focusSearch\(\): void \{[\s\S]*?searchOpen\.value = true/);
  assert.match(app, /<SearchPanel[\s\S]*?v-if="searchOpen"/);
});

test("the panel replaces the list instead of floating over it (no second scroll layer)", () => {
  assert.match(app, /<nav class="conversation-list" v-show="!hiddenOpen && !searchOpen"/);
});

test("S2: a message hit opens the chat around that message (messagesync both ways from start=seq) and highlights it 2 s", () => {
  const open = app.slice(app.indexOf("async function openChannel"), app.indexOf("function openContact"));
  assert.match(open, /async function openChannel\(channel: Channel, around\?: number\)/);
  assert.match(open, /startMessageSeq: around[\s\S]*?pullMode: PullMode\.Down[\s\S]*?startMessageSeq: around[\s\S]*?pullMode: PullMode\.Up/);
  assert.match(open, /locate\(around\)/);
  assert.match(app, /const locateMs = 2000;/);
  assert.match(app, /:data-seq="message\.messageSeq"/);
  assert.match(app, /located: message\.messageSeq === locatedSeq/);
  assert.match(app, /@message="\(hit\) => openFromSearch\(hit\.channel, hit\.seq\)"/);
});

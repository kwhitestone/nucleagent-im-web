// UNI-IM-DB W5: im-web against the MySQL-backed history (W4). Live WS messages carry WuKong
// seqs, history carries im's ids; the two are merged by time and only history feeds the cursor.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after } from "node:test";
import { Channel, ChannelTypePerson, Message, MessageText, WKSDK } from "wukongimjssdk";
import { carryPersisted, earlierCursor, markPersisted, mergeMessages, remintGuard } from "../src/history.ts";
import { configureSDK, loadMoreConversations, markRead, messageFromRow } from "../src/im.ts";

const app = readFileSync("src/App.vue", "utf8");
// WKSDK.shared() starts the SDK's receipt flush interval; without this the test process never exits.
after(() => clearInterval((WKSDK.shared().receiptManager as unknown as { timer: ReturnType<typeof setInterval> }).timer));
const session = { uid: "11", token: "t", wsAddr: "ws://im", jwt: "jwt" };

function msg(id: string, seq: number, timestamp: number, persisted: boolean, clientMsgNo = `c-${id}`): Message {
  const m = new Message();
  m.messageID = id;
  m.messageSeq = seq;
  m.clientMsgNo = clientMsgNo;
  m.timestamp = timestamp;
  m.content = new MessageText(id);
  return persisted ? markPersisted(m) : m;
}

type Call = { url: string; body: Record<string, unknown> };
function stubFetch(reply: (call: Call) => unknown): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), body: JSON.parse(String(init.body || "{}")) };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

const row = (id: number, ts: number) => ({
  message_id: id, message_idstr: `w${id}`, message_seq: id, client_msg_no: `c${id}`, from_uid: "12",
  channel_id: "12", channel_type: 1, timestamp: ts, payload: btoa(JSON.stringify({ type: 1, content: `m${id}` })),
});

test("spec W5 check: live seq-1 messages plus history ids 500-529 → the load-earlier cursor is 499 (below 500)", () => {
  const history = Array.from({ length: 30 }, (_, i) => msg(`h${i}`, 500 + i, 1000 + i, true));
  const live = [msg("live-a", 1, 2000, false), msg("live-b", 2, 2001, false)];
  const merged = mergeMessages(history, live);
  assert.equal(earlierCursor(merged), 499);
  // Time order, not seq: the two live seq-1/2 messages are the newest, so they sit last.
  assert.deepEqual(merged.slice(-3).map((m) => m.messageID), ["h29", "live-a", "live-b"]);
  assert.equal(earlierCursor(live), undefined, "with no history row there is no cursor (never 0 = latest)");
});

test("a live message is replaced by its persisted twin (same client_msg_no), not duplicated", () => {
  const live = msg("", 7, 1500, false, "sdk-uuid_0_3");
  const persisted = msg("2106239242794438656", 812, 1500, true, "sdk-uuid_0_3");
  const merged = mergeMessages([msg("h1", 811, 1499, true), live], [persisted]);
  assert.deepEqual(merged.map((m) => m.messageSeq), [811, 812]);
  assert.equal(earlierCursor(merged), 810);
});

test("same-second history rows keep im's id order; mixed live/history ties keep arrival order", () => {
  const merged = mergeMessages([msg("b", 41, 5, true), msg("a", 40, 5, true)], [msg("x", 900, 5, false)]);
  assert.deepEqual(merged.map((m) => m.messageID), ["a", "b", "x"]);
});

test("re-mint guard: one attempt per failure streak, re-armed by a successful connect", () => {
  const guard = remintGuard();
  assert.equal(guard.take(), true);
  assert.equal(guard.take(), false, "a second auth-fail before any success must not loop");
  guard.reset();
  assert.equal(guard.take(), true);
});

test("history rows from im are marked persisted, so their ids feed the cursor", async () => {
  const stub = stubFetch(() => ({ messages: [row(500, 10), row(501, 11)], more: 1 }));
  try {
    configureSDK(session);
    const rows = await WKSDK.shared().config.provider.syncMessagesCallback!(new Channel("12", ChannelTypePerson), {
      limit: 30, startMessageSeq: 0, endMessageSeq: 0, pullMode: 1,
    } as never);
    assert.equal(earlierCursor(rows), 499);
    assert.match(stub.calls[0].url, /\/api\/v1\/im\/channel\/messagesync$/);
  } finally {
    stub.restore();
  }
});

test("conversation list: the SDK sync takes page 1, load-more follows next_cursor until done", async () => {
  const pages: Record<string, unknown> = {
    "": { conversations: [{ channel_id: "12", channel_type: 1, unread: 2, last_message: row(9, 99) }], next_cursor: "9", done: false },
    "9": { conversations: [{ channel_id: "13", channel_type: 1, unread: 0, last_message: row(5, 50) }], next_cursor: "", done: true },
  };
  const stub = stubFetch(({ body }) => pages[String(body.cursor || "")]);
  try {
    configureSDK(session);
    const first = await WKSDK.shared().config.provider.syncConversationsCallback!(undefined);
    assert.deepEqual(first.map((c) => [c.channel.channelID, c.unread]), [["12", 2]]);
    const second = await loadMoreConversations(session);
    assert.deepEqual(second.map((c) => c.channel.channelID), ["13"]);
    assert.deepEqual(await loadMoreConversations(session), [], "done: no further request");
    assert.deepEqual(stub.calls.map((c) => c.body), [{}, { cursor: "9" }]);
  } finally {
    stub.restore();
  }
});

test("markRead posts the channel to /conversation/read", async () => {
  const stub = stubFetch(() => ({ code: 0, message: "success", data: null }));
  try {
    await markRead(new Channel("12", ChannelTypePerson), session);
    assert.match(stub.calls[0].url, /\/api\/v1\/im\/conversation\/read$/);
    assert.deepEqual(stub.calls[0].body, { channel_id: "12", channel_type: 1 });
  } finally {
    stub.restore();
  }
});

// App.vue wiring (the suite renders no SDK-driven App; it pins the call sites like the other App tests).
test("opening a channel marks it read; a message arriving in the open channel does too", () => {
  const open = app.slice(app.indexOf("async function openChannel"), app.indexOf("function openContact"));
  assert.match(open, /markChannelRead\(channel\)/);
  const live = app.slice(app.indexOf("const messageListener"), app.indexOf("const eventListener"));
  assert.match(live, /if \(!isOwnMessage\(message\)\) markChannelRead\(message\.channel\)/);
  assert.match(app, /function markChannelRead[\s\S]*?local\.unread = 0[\s\S]*?markRead\(channel, readSession\)/);
});

test("reconnect re-pulls the open channel's latest history and merges it", () => {
  const status = app.slice(app.indexOf("const connectStatusListener"), app.indexOf("const conversationListener"));
  assert.match(status, /ConnectStatus\.Connected[\s\S]*?refreshActiveHistory\(\)/);
  assert.match(app, /async function refreshActiveHistory[\s\S]*?startMessageSeq: 0[\s\S]*?mergeMessages\(messages\.value, latest\)/);
});

test("auth failure re-mints the connect token once and reconnects", () => {
  const status = app.slice(app.indexOf("const connectStatusListener"), app.indexOf("const conversationListener"));
  assert.match(status, /reasonCode === 2\)[\s\S]*?if \(remint\.take\(\)\) void remintConnectToken\(\)/);
  assert.match(status, /ConnectStatus\.Connected\)[\s\S]*?remint\.reset\(\)/);
  assert.match(app, /async function remintConnectToken[\s\S]*?imSession\(\{ accessToken: current\.jwt \}\)[\s\S]*?disconnect\(\)[\s\S]*?configureSDK\(next\)[\s\S]*?sdk\.connect\(\)/);
});

test("load earlier uses the history cursor, never the first (possibly live) message's seq", () => {
  const earlier = app.slice(app.indexOf("async function loadEarlier"), app.indexOf("function insertMention"));
  assert.match(earlier, /const cursor = earlierCursor\(messages\.value\)/);
  assert.match(earlier, /startMessageSeq: cursor,/);
  assert.doesNotMatch(earlier, /first\.messageSeq/);
});

test("the conversation list loads the next page when scrolled near its end", () => {
  assert.match(app, /<nav class="conversation-list"[^>]*@scroll\.passive="conversationListScrolled"/);
  assert.match(app, /function conversationListScrolled[\s\S]*?loadMoreConversationPage\(\)/);
});

test("the oldest row (id 1) yields cursor 0 and load-earlier marks history finished instead of a silent no-op", () => {
  assert.equal(earlierCursor([msg("first", 1, 1, true), msg("second", 2, 2, true)]), 0);
  const earlier = app.slice(app.indexOf("async function loadEarlier"), app.indexOf("function insertMention"));
  assert.match(earlier, /cursor === undefined \|\|/);
  assert.match(earlier, /if \(cursor === 0\) \{\s*historyFinished\.value = true;/);
});

test("a streamed update keeps a history row persisted (the stream path clones the message)", () => {
  const row = msg("h1", 600, 1, true);
  const copy = carryPersisted(row, Object.assign(new Message(), row));
  assert.equal(earlierCursor([copy]), 599);
  assert.equal(earlierCursor([carryPersisted(msg("live", 3, 1, false), new Message())]), undefined);
  assert.match(app, /const changed = carryPersisted\(existing, Object\.assign\(new Message\(\), existing\)\)/);
});

test("history keeps the exact snowflake from message_idstr (the numeric message_id is past 2^53)", () => {
  const m = messageFromRow({ ...row(1, 1), message_id: 2106239242794438656, message_idstr: "2106239242794438656" });
  assert.equal(m.messageID, "2106239242794438656");
});

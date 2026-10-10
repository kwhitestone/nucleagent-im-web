// IM-FIX1: the conversation list is pulled once at a time and keeps the pages already loaded;
// a sent message counts as sent only once WuKongIM acked it; the undo toast lasts 10 s and
// pauses while the pointer or keyboard focus is on it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { after, mock } from "node:test";
import { shallowRef } from "vue";
import { Channel, ChannelTypeGroup, Conversation, Message, MessageText, WKSDK, type SendackPacket } from "wukongimjssdk";
import { configureSDK, loadMoreConversations, sendAcked } from "../src/im.ts";
import { undoMs, useConversationBatch } from "../src/hiding.ts";

after(() => clearInterval((WKSDK.shared().receiptManager as unknown as { timer: ReturnType<typeof setInterval> }).timer));
const app = readFileSync("src/App.vue", "utf8");
const session = { uid: "11", token: "t", wsAddr: "ws://im", jwt: "jwt" };

type Call = { url: string; body: Record<string, unknown> };
function stubFetch(reply: (call: Call) => unknown) {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), body: JSON.parse(String(init.body || "{}")) };
    calls.push(call);
    return new Response(JSON.stringify(reply(call)), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const item = (id: string) => ({ channel_id: id, channel_type: 2, unread: 0, active_at: 1 });
// 50 + 28, as DEV in AS3 (the cursor is the last row's id).
const pages: Record<string, unknown> = {
  "": { conversations: Array.from({ length: 50 }, (_, i) => item(`a${i}`)), next_cursor: "50", done: false },
  "50": { conversations: Array.from({ length: 28 }, (_, i) => item(`b${i}`)), next_cursor: "", done: true },
};
const sync = () => WKSDK.shared().config.provider.syncConversationsCallback!(undefined);
const ids = (list: Conversation[]) => list.map((c) => c.channel.channelID);

test("concurrent list syncs (connect + tab back in front + …) share one request", async () => {
  const stub = stubFetch(({ body }) => pages[String(body.cursor || "")]);
  try {
    configureSDK({ ...session, uid: "fix1-a" });
    const results = await Promise.all([sync(), sync(), sync()]);
    assert.equal(stub.calls.length, 1, "one in-flight pull, not one per trigger");
    for (const r of results) assert.equal(r.length, 50);
    await sync();
    assert.equal(stub.calls.length, 2, "a later sync (after the first finished) pulls again");
  } finally { stub.restore(); }
});

test("a re-sync keeps the pages already loaded instead of dropping back to page 1", async () => {
  const stub = stubFetch(({ body }) => pages[String(body.cursor || "")]);
  try {
    configureSDK({ ...session, uid: "fix1-b" });
    assert.equal((await sync()).length, 50);
    assert.equal((await loadMoreConversations(session)).length, 28);
    const again = await sync();
    assert.equal(again.length, 78, "both pages come back in one sync");
    assert.deepEqual(ids(again).slice(48, 52), ["a48", "a49", "b0", "b1"]);
    assert.deepEqual(await loadMoreConversations(session), [], "the list is complete: no scroll re-request");
    assert.deepEqual(stub.calls.map((c) => c.body), [{}, { cursor: "50" }, {}, { cursor: "50" }]);
  } finally { stub.restore(); }
});

test("a new account starts from one page again", async () => {
  const stub = stubFetch(({ body }) => pages[String(body.cursor || "")]);
  try {
    configureSDK({ ...session, uid: "fix1-c" });
    await sync();
    await loadMoreConversations(session);
    configureSDK({ ...session, uid: "fix1-d" });
    assert.equal((await sync()).length, 50);
  } finally { stub.restore(); }
});

test("sendAcked resolves only after WuKongIM's sendack for that packet", async () => {
  const chat = WKSDK.shared().chatManager;
  const original = chat.send;
  const sent = new Message();
  sent.clientSeq = 7;
  chat.send = async () => sent;
  try {
    let done = false;
    const pending = sendAcked(new MessageText("hi"), new Channel("g", ChannelTypeGroup)).then((m) => { done = true; return m; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "queued in the SDK is not sent yet");
    chat.notifyMessageStatusListeners({ clientSeq: 6 } as SendackPacket);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done, false, "another packet's ack does not count");
    chat.notifyMessageStatusListeners({ clientSeq: 7 } as SendackPacket);
    assert.equal(await pending, sent);
    assert.equal(chat.sendStatusListeners.length, 0, "the ack listener is removed");
  } finally { chat.send = original; }
});

test("sendAcked fails (draft kept) when no ack arrives in time", async () => {
  const chat = WKSDK.shared().chatManager;
  const original = chat.send;
  chat.send = async () => Object.assign(new Message(), { clientSeq: 9 });
  try {
    await assert.rejects(sendAcked(new MessageText("hi"), new Channel("g", ChannelTypeGroup), 5));
    assert.equal(chat.sendStatusListeners.length, 0);
  } finally { chat.send = original; }
});

test("the composer clears the draft only after the ack", () => {
  const send = app.slice(app.indexOf("async function sendMessage"), app.indexOf("function showCreateGroup"));
  assert.match(send, /await sendAcked\(content, channel\)[\s\S]*?draft\.value = ""/);
  assert.doesNotMatch(send, /chatManager\.send\(/);
});

test("undo lasts 10 s and pauses while hovered or focused", async () => {
  mock.timers.enable({ apis: ["setTimeout"] });
  const conversations = shallowRef([Object.assign(new Conversation(), { channel: new Channel("a", ChannelTypeGroup), timestamp: 1 })]);
  const batch = useConversationBatch({ session: () => session, conversations, t: (k) => k });
  const stub = stubFetch(() => ({ results: [{ channel_id: "a", channel_type: 2, ok: true }] }));
  try {
    assert.equal(undoMs, 10000);
    await batch.run("hide", ["2:a"]);
    mock.timers.tick(4000);
    batch.pauseNotice();
    mock.timers.tick(60000);
    assert.ok(batch.notice.value?.undo, "paused: still offered after a minute");
    batch.pauseNotice(); // pointer and focus both on it
    batch.resumeNotice(); // pointer leaves, focus stays
    mock.timers.tick(60000);
    assert.ok(batch.notice.value?.undo, "still focused: still paused");
    batch.resumeNotice();
    mock.timers.tick(undoMs - 1);
    assert.ok(batch.notice.value?.undo, "resumed: a full undoMs again");
    mock.timers.tick(1);
    assert.equal(batch.notice.value, undefined);
    batch.resumeNotice();
    assert.equal(batch.notice.value, undefined, "resume after expiry brings nothing back");
  } finally { stub.restore(); batch.reset(); mock.timers.reset(); }
});

test("the toast wires pointer and keyboard focus to pause/resume", () => {
  const toast = app.slice(app.indexOf('data-testid="im-notice"') - 200, app.indexOf('data-testid="im-notice"') + 100);
  for (const wire of [/@mouseenter="batch\.pauseNotice\(\)"/, /@mouseleave="batch\.resumeNotice\(\)"/, /@focusin="batch\.pauseNotice\(\)"/, /@focusout="batch\.resumeNotice\(\)"/]) {
    assert.match(toast, wire);
  }
});

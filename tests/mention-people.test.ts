// IM-FIX-1 (需求3): @ a human group member next to agents. People ride the same WuKong
// mention.uids as agents (the server only dispatches agent accounts), never `all`.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { ChannelTypeGroup, ChannelTypePerson, Mention, MessageText } from "wukongimjssdk";
import { buildOutgoingText, mentionsMe, mentionCandidates } from "../src/mentions.ts";

const app = readFileSync("src/App.vue", "utf8");
const encoded = (content: MessageText) => JSON.parse(new TextDecoder().decode(content.encode()));
const members = [
  { uid: 1, username: "me", displayName: "Me", avatar: "", accountType: "human" as const },
  { uid: 37, username: "payroll", displayName: "Payroll bot", avatar: "", accountType: "agent" as const },
  { uid: 5, username: "alice", displayName: "Alice", avatar: "a.png", accountType: "human" as const },
];

test("people and agents share mention.uids; agents-only callers are unchanged; DMs carry none", () => {
  assert.deepEqual(encoded(buildOutgoingText("@Payroll bot @Alice hi", ChannelTypeGroup, ["37"], ["5", "37"])),
    { content: "@Payroll bot @Alice hi", type: 1, mention: { uids: ["37", "5"] } });
  assert.deepEqual(encoded(buildOutgoingText("@Payroll bot", ChannelTypeGroup, ["37"])),
    { content: "@Payroll bot", type: 1, mention: { uids: ["37"] } });
  assert.deepEqual(encoded(buildOutgoingText("hi", ChannelTypePerson, ["37"], ["5"])), { content: "hi", type: 1 });
});

test("candidates are the group's members minus the viewer, agents first, filtered by query", () => {
  assert.deepEqual(mentionCandidates(members, "1", "").map((m) => m.uid), [37, 5]);
  assert.deepEqual(mentionCandidates(members, "1", "ali").map((m) => m.uid), [5]);
  assert.deepEqual(mentionCandidates(members, "1", "me"), []);
});

test("mentionsMe reads explicit uids only, never all", () => {
  const content = (uids: string[], all = false) => {
    const text = new MessageText("x");
    text.mention = Object.assign(new Mention(), { uids, all });
    return text;
  };
  assert.equal(mentionsMe(content(["5"]), "5"), true);
  assert.equal(mentionsMe(content(["37"]), "5"), false);
  assert.equal(mentionsMe(new MessageText("x"), "5"), false);
  assert.equal(mentionsMe(undefined, "5"), false);
});

test("App: suggestions list people, people go to their own list, agents-only send gate, @me marks", () => {
  assert.match(app, /mentionCandidates\(activeGroupMembers\.value/);
  assert.match(app, /const mentionedPersonUids = ref<string\[\]>\(\[\]\)/);
  const insert = app.slice(app.indexOf("function insertMention"), app.indexOf("function removeMention"));
  assert.match(insert, /accountType === "agent"[\s\S]*mentionedAgentUids[\s\S]*mentionedPersonUids/);
  const send = app.slice(app.indexOf("async function sendMessage"), app.indexOf("async function sendMessage") + 2500);
  assert.match(send, /buildOutgoingText\(text, channel\.channelType, mentionUids, personUids\)/);
  assert.match(send, /\}, mentionUids\);/, "only agents go through the recipient-enabled gate");
  assert.match(app, /data-testid="mention-me"/);
  assert.match(app, /class="bubble"[^>]*mentionsMe\(message\.content/);
});

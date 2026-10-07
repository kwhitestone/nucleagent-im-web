import assert from "node:assert/strict";
import test from "node:test";
import { parseConversationTarget, resolveConversationTarget } from "../src/conversationTarget.ts";

test("canonical DM resolves to the viewer's peer, not the canonical pair", () => {
  const target = parseConversationTarget({ channelId: "1@17", channelType: 1, agentUid: "17" })!;
  assert.deepEqual(resolveConversationTarget(target, "1"), { channelID: "17", channelType: 1 });
  assert.deepEqual(resolveConversationTarget(target, "17"), { channelID: "1", channelType: 1 });
  assert.equal(resolveConversationTarget(target, "2"), null);
});

test("group target preserves its channel ID", () => {
  const target = parseConversationTarget({ channelId: "g-123", channelType: 2, agentUid: "17" })!;
  assert.deepEqual(resolveConversationTarget(target, "1"), { channelID: "g-123", channelType: 2 });
});

test("malformed, noncanonical and unrelated agent references fail closed", () => {
  const target = { channelId: "1@17", channelType: 1, agentUid: "17" };
  for (const value of [null, [], {}, { ...target, channelId: "17@1" }, { ...target, channelId: "1@1" },
    { ...target, channelId: "1" }, { ...target, channelType: 3 }, { ...target, agentUid: "2" },
    { ...target, channelId: "01@17" }, { ...target, channelId: "1@17@20" }]) {
    assert.equal(parseConversationTarget(value), null);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { ChannelTypeGroup, ChannelTypePerson } from "wukongimjssdk";
import { buildOutgoingText, buildTextContent } from "../src/mentions.ts";

function encoded(content: ReturnType<typeof buildTextContent>) {
  return JSON.parse(new TextDecoder().decode(content.encode()));
}

test("group messages encode explicit mention.uids", () => {
  assert.deepEqual(
    encoded(buildOutgoingText("hello @Agent", ChannelTypeGroup, ["42", "42", "7"])),
    {
      content: "hello @Agent",
      type: 1,
      mention: { uids: ["42", "7"] },
    },
  );
});

test("direct messages remain always-on without mention metadata", () => {
  assert.deepEqual(
    encoded(buildOutgoingText("hello agent", ChannelTypePerson, ["42"])),
    { content: "hello agent", type: 1 },
  );
});

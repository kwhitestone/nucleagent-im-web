import assert from "node:assert/strict";
import test from "node:test";
import { parseStreamEvent } from "../src/stream.ts";

test("stream events append text and finish", () => {
  const started = parseStreamEvent("___TextMessageStart", { stream_no: "s1" });
  assert.deepEqual(started, { key: "s1", text: "", done: false });

  const chunk = parseStreamEvent("stream.delta", {
    client_msg_no: "s1",
    payload: { delta: "hello" },
  }, started?.text);
  assert.deepEqual(chunk, { key: "s1", text: "hello", done: false });

  const ended = parseStreamEvent("stream.close", {
    client_msg_no: "s1",
    payload: { snapshot: { text: "hello world" } },
  }, chunk?.text);
  assert.deepEqual(ended, { key: "s1", text: "hello world", done: true });
});

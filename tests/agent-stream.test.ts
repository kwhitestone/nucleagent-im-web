import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAgentStreamEvent,
  browserStreamChannelId,
  connectAgentStream,
  parseAgentStreamEvent,
  parseSSEBlock,
  reconcileLiveResponses,
  type LiveAgentResponse,
} from "../src/stream.ts";

test("agent stream replaces cumulative snapshots and suppresses the durable duplicate", () => {
  let responses: LiveAgentResponse[] = [];
  responses = applyAgentStreamEvent(responses, {
    id: "1:0",
    type: "open",
    sourceKey: "source",
    agentUid: "8",
  });
  assert.equal(responses[0].status, "busy");

  responses = applyAgentStreamEvent(responses, {
    id: "1:1",
    type: "snapshot",
    sourceKey: "source",
    text: "Hel",
    revision: 1,
  });
  responses = applyAgentStreamEvent(responses, {
    id: "1:2",
    type: "snapshot",
    sourceKey: "source",
    text: "Hello",
    revision: 2,
  });
  responses = applyAgentStreamEvent(responses, {
    id: "1:1",
    type: "snapshot",
    sourceKey: "source",
    text: "stale",
    revision: 1,
  });
  assert.equal(responses[0].text, "Hello");

  responses = applyAgentStreamEvent(responses, {
    id: "1:3",
    type: "complete",
    sourceKey: "source",
    text: "Hello world",
    revision: 3,
    clientMsgNo: "durable-1",
  });
  assert.equal(responses[0].status, "complete");
  assert.deepEqual(reconcileLiveResponses(responses, ["durable-1"]), []);
});

test("agent stream exposes terminal failure as state, not message content", () => {
  const responses = applyAgentStreamEvent([], {
    id: "2:0",
    type: "error",
    sourceKey: "failed",
    code: "execution_failed",
  });
  assert.deepEqual(responses[0], {
    sourceKey: "failed",
    agentUid: "",
    text: "",
    revision: 0,
    status: "error",
  });
});

test("SSE parsing and person-channel canonicalization follow the browser contract", () => {
  const message = parseSSEBlock(
    "id: 7:2\nevent: snapshot\ndata: {\"sourceKey\":\"s\",\"text\":\"Hi\",\"revision\":2}",
  );
  assert.ok(message);
  assert.deepEqual(parseAgentStreamEvent(message), {
    id: "7:2",
    type: "snapshot",
    sourceKey: "s",
    text: "Hi",
    revision: 2,
  });
  assert.equal(browserStreamChannelId("42", 1, "7"), "7@42");
  assert.equal(browserStreamChannelId("group-id", 2, "7"), "group-id");
});

test("agent stream reconnect resumes with Last-Event-ID", async () => {
  const controller = new AbortController();
  const headers: Array<Record<string, string>> = [];
  let call = 0;
  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string>);
    call += 1;
    if (call === 1) {
      return new Response(
        "id: 8:1\nevent: snapshot\ndata: {\"sourceKey\":\"s\",\"text\":\"Hi\",\"revision\":1}\n\n",
        { status: 200 },
      );
    }
    controller.abort();
    return new Response("", { status: 200 });
  };

  await connectAgentStream({
    baseUrl: "http://im.test",
    channelId: "7@42",
    channelType: 1,
    jwt: "jwt",
    signal: controller.signal,
    fetcher: fetcher as typeof fetch,
    retryDelay: async () => {},
    onEvent() {},
  });

  assert.equal(call, 2);
  assert.equal(headers[0].Authorization, "Bearer jwt");
  assert.equal(headers[0]["Last-Event-ID"], undefined);
  assert.equal(headers[1]["Last-Event-ID"], "8:1");
});

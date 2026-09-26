import assert from "node:assert/strict";
import test from "node:test";
import {
  applyAgentStreamEvent,
  browserStreamChannelId,
  connectAgentStream,
  parseAgentStreamEvent,
  parseSSEBlock,
  reconnectDelayMs,
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
  // The code is retained as state so the UI can name the cause; the failing text is
  // still never rendered as agent speech.
  assert.deepEqual(responses[0], {
    sourceKey: "failed",
    agentUid: "",
    text: "",
    revision: 0,
    status: "error",
    code: "execution_failed",
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
  assert.equal(headers[0].Authorization, "jwt");
  assert.equal(headers[0]["Last-Event-ID"], undefined);
  assert.equal(headers[1]["Last-Event-ID"], "8:1");
});

test("agent stream mints a fresh token on 401 and reconnects once with the cursor", async () => {
  const controller = new AbortController();
  const headers: Array<Record<string, string>> = [];
  const states: string[] = [];
  let refreshes = 0;
  let call = 0;

  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    headers.push(init?.headers as Record<string, string>);
    call += 1;
    if (call === 1) {
      return new Response(
        "id: 9:1\nevent: snapshot\ndata: {\"sourceKey\":\"s\",\"text\":\"Hi\",\"revision\":1}\n\n",
        { status: 200 },
      );
    }
    if (call === 2) return new Response("", { status: 401 });
    controller.abort();
    return new Response("", { status: 200 });
  };

  await connectAgentStream({
    baseUrl: "http://im.test",
    channelId: "7@42",
    channelType: 1,
    jwt: "expired",
    signal: controller.signal,
    fetcher: fetcher as typeof fetch,
    retryDelay: async () => {},
    refreshToken: async () => {
      refreshes += 1;
      return "fresh";
    },
    onConnectionChange(state) {
      states.push(state);
    },
    onEvent() {},
  });

  assert.equal(refreshes, 1, "one refresh, not one per retry");
  assert.equal(headers[1].Authorization, "expired");
  assert.equal(headers[2].Authorization, "fresh", "reconnect must use the new token");
  assert.equal(headers[2]["Last-Event-ID"], "9:1", "cursor must survive the refresh");
  assert.ok(!states.includes("disconnected"), "a successful refresh is not a disconnect");
});

test("reconnect backoff doubles from one second and caps at thirty", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(reconnectDelayMs),
    [1000, 2000, 4000, 8000, 16000, 30000, 30000],
  );
});

test("agent stream surfaces a disconnected state instead of retrying forever", async () => {
  const controller = new AbortController();
  const states: string[] = [];
  const delays: number[] = [];
  let call = 0;

  await connectAgentStream({
    baseUrl: "http://im.test",
    channelId: "7@42",
    channelType: 1,
    jwt: "expired",
    signal: controller.signal,
    // Every attempt is rejected and no refresher exists, so the loop must give up.
    fetcher: (async () => {
      call += 1;
      return new Response("", { status: 401 });
    }) as unknown as typeof fetch,
    retryDelay: async (_signal, delayMs) => {
      delays.push(delayMs);
    },
    maxConsecutiveFailures: 5,
    onConnectionChange(state) {
      states.push(state);
    },
    onEvent() {},
  });

  assert.equal(call, 5, "stops at the failure cap rather than looping at ~1 Hz");
  assert.equal(states.at(-1), "disconnected");
  assert.deepEqual(delays, [1000, 2000, 4000, 8000]);
});

test("agent stream refreshes proactively before the access token expires", async () => {
  const controller = new AbortController();
  let clock = 0;
  let refreshes = 0;
  const tokens: string[] = [];
  let call = 0;

  const fetcher = async (_input: RequestInfo | URL, init?: RequestInit) => {
    const sent = (init?.headers as Record<string, string>).Authorization;
    tokens.push(sent);
    call += 1;
    if (call === 1) {
      // The stream ends after 14 minutes, inside the two-minute refresh window.
      clock += 14 * 60 * 1000;
      return new Response("", { status: 200 });
    }
    controller.abort();
    return new Response("", { status: 200 });
  };

  await connectAgentStream({
    baseUrl: "http://im.test",
    channelId: "7@42",
    channelType: 1,
    jwt: "original",
    signal: controller.signal,
    fetcher: fetcher as typeof fetch,
    retryDelay: async () => {},
    now: () => clock,
    refreshToken: async () => {
      refreshes += 1;
      return `rotated-${refreshes}`;
    },
    onEvent() {},
  });

  assert.equal(tokens[0], "original");
  assert.equal(refreshes, 1, "rotated once, without waiting for a 401");
  assert.equal(tokens[1], "rotated-1");
});

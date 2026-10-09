import assert from "node:assert/strict";
import test from "node:test";
import { sendToEnabledRecipient } from "../src/send.ts";

test("recipient gate blocks before SDK, retries only on demand, and cancels stale sends", async () => {
  const originalFetch = globalThis.fetch;
  const session = { uid: "5", token: "im", jwt: "jwt", wsAddr: "ws://im" };
  const channel = { channelID: "33", channelType: 1 };
  let calls = 0, sends = 0;
  let body: unknown = { enabled: false };
  let fail = false, current = true, cancelDuringCheck = false;
  globalThis.fetch = async (url, init) => {
    calls++;
    assert.match(String(url), /\/im\/recipients\/33$/);
    assert.equal((init?.headers as Record<string, string>).Authorization, "jwt");
    assert.equal(init?.cache, "no-store");
    assert(init?.signal);
    if (cancelDuringCheck) current = false;
    if (fail) throw new TypeError("offline");
    return Response.json({ code: 0, data: body });
  };
  const run = (target = channel) => sendToEnabledRecipient(
    target, session, () => current, async () => { sends++; },
  );
  try {
    assert.equal(await run(), "disabled");
    assert.equal(sends, 0);
    assert.equal(calls, 1);
    body = { enabled: true };
    assert.equal(await run(), "sent");
    assert.equal(sends, 1);
    fail = true;
    calls = 0;
    assert.equal(await run(), "unavailable");
    assert.equal(calls, 2);
    assert.equal(sends, 1);
    fail = false;
    assert.equal(await run(), "sent", "next send recovers without a background loop");
    body = {};
    assert.equal(await run(), "unavailable", "malformed status must not fail open");
    body = { enabled: true };
    cancelDuringCheck = true;
    assert.equal(await run(), "cancelled");
    assert.equal(sends, 2, "account/channel changes must prevent the SDK invocation");
    current = true;
    calls = 0;
    assert.equal(await run({ channelID: "group", channelType: 2 }), "sent");
    assert.equal(calls, 0, "a disabled group member must not block the group message");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("AG1-B2: a DM to a disabled agent account is refused before the SDK and reads as deleted", async () => {
  const { recipientDisabledKey } = await import("../src/send.ts");
  assert.equal(recipientDisabledKey(true), "composer.agentDeleted");
  assert.equal(recipientDisabledKey(false), "composer.recipientDisabled");
});

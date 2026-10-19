import assert from "node:assert/strict";
import test, { after } from "node:test";
import { Channel, WKSDK } from "wukongimjssdk";
import { configureSDK } from "../src/im.ts";
import type { ConnectSession } from "../src/api.ts";

after(() => clearInterval((WKSDK.shared().receiptManager as any).timer));
const options = { startMessageSeq: 0, endMessageSeq: 0, pullMode: 0, limit: 30 };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
let serial = 0;

test("SDK reconnect providers use the renewed session, without minting or replacing the socket", async () => {
  const original = globalThis.fetch;
  let current: ConnectSession = { uid: `binding-${++serial}`, token: "synthetic-im", jwt: "synthetic-old", wsAddr: "ws://fixture" };
  const calls: Array<{ path: string; fresh: boolean }> = [];
  globalThis.fetch = async (url, init) => {
    const fresh = new Headers(init?.headers).get("Authorization") === current.jwt;
    calls.push({ path: new URL(String(url)).pathname, fresh });
    return fresh ? json({ conversations: [], messages: [], done: true }) : json({ message: "expired" }, 401);
  };
  try {
    const sdk = configureSDK(current, () => current);
    const token = sdk.config.token;
    current = { ...current, jwt: "synthetic-new" };
    await sdk.config.provider.syncConversationsCallback!(undefined);
    await sdk.config.provider.syncMessagesCallback!(new Channel("synthetic", 2), options);
    assert.deepEqual(calls.map(c => c.fresh), [true, true]);
    assert.equal(sdk.config.token, token);
    assert(calls.every(c => !c.path.endsWith("connect-token")));
  } finally { globalThis.fetch = original; }
});

for (const status of [200, 401]) {
  test(`late ${status} from a retired session cannot settle the new SDK sweep`, async () => {
    const original = globalThis.fetch;
    let current: ConnectSession = { uid: `binding-${++serial}`, token: "synthetic", jwt: "old", wsAddr: "ws://fixture" };
    let finish!: (response: Response) => void;
    let retiredSignal: AbortSignal | undefined;
    let calls = 0;
    globalThis.fetch = async (_url, init) => {
      if (++calls === 1) {
        retiredSignal = init?.signal as AbortSignal;
        return new Promise<Response>(resolve => { finish = resolve; });
      }
      return json({ conversations: [], done: true });
    };
    try {
      const sdk = configureSDK(current, () => current);
      const old = sdk.config.provider.syncConversationsCallback!(undefined);
      const outcome = old.then(() => "resolved", error => error.name);
      current = { ...current, jwt: "new" };
      const fresh = sdk.config.provider.syncConversationsCallback!(undefined);
      finish(json(status === 200 ? { conversations: [], next_cursor: "stale", done: false } : { message: "expired" }, status));
      const freshOutcome = await fresh.catch(() => "rejected");
      assert.equal(await outcome, "AbortError");
      assert.equal(retiredSignal?.aborted, true, "renewal cancels the retired request");
      assert.notEqual(old, fresh, "a renewal must not join the retired single-flight");
      assert.deepEqual(freshOutcome, []);
      assert.equal(calls, 2);
    } finally { globalThis.fetch = original; }
  });
}

test("current-generation backend 401 remains a rejection, never an empty success", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => json({ message: "backend_denied" }, 401);
  try {
    const sdk = configureSDK({ uid: `binding-${++serial}`, token: "synthetic", jwt: "synthetic", wsAddr: "ws://fixture" });
    await assert.rejects(sdk.config.provider.syncConversationsCallback!(undefined), /backend_denied/);
    await assert.rejects(sdk.config.provider.syncMessagesCallback!(new Channel("synthetic", 2), options), /backend_denied/);
  } finally { globalThis.fetch = original; }
});

test("retired providers cannot issue requests for another identity or a logged-out session", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return json({ messages: [] }); };
  let current: ConnectSession | undefined = { uid: `binding-${++serial}`, token: "synthetic", jwt: "old", wsAddr: "ws://fixture" };
  try {
    const sdk = configureSDK(current, () => current);
    const old = sdk.config.provider.syncMessagesCallback!;
    current = { ...current, uid: "other", jwt: "new" };
    configureSDK(current, () => current);
    await assert.rejects(old(new Channel("synthetic", 2), options), { name: "AbortError" });
    current = undefined;
    await assert.rejects(sdk.config.provider.syncMessagesCallback!(new Channel("synthetic", 2), options), { name: "AbortError" });
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

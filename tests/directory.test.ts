import assert from "node:assert/strict";
import test from "node:test";
import { provisionContact, searchDirectory, type ConnectSession } from "../src/api.ts";

const session: ConnectSession = { uid: "1", token: "im", wsAddr: "ws://im", jwt: "jwt" };

function stubFetch(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const [status, body] = responses[calls.length - 1];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("directory search returns merged entries with paging", async () => {
  const page = { items: [{ id: 0, portalUid: 7, username: "", displayName: "Ann", accountType: "human", provisioned: false }], page: 2, hasMore: true, degraded: false };
  const f = stubFetch([[200, { code: 0, message: "success", data: page }]]);
  try {
    assert.deepEqual(await searchDirectory(" an ", session, 2), page);
  } finally { f.restore(); }
  assert.match(f.calls[0].url, /\/api\/v1\/addons\/auth\/directory\/search\?q=an&page=2$/);
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "jwt");
});

test("kill-switch off (404) falls back to contacts search, provisioned only", async () => {
  const f = stubFetch([
    [404, { code: 404, message: "directory is disabled" }],
    [200, { code: 0, message: "success", data: [{ id: 5, username: "bob", displayName: "Bob", accountType: "human" }] }],
  ]);
  let page;
  try { page = await searchDirectory("bo", session); } finally { f.restore(); }
  assert.match(f.calls[1].url, /\/contacts\/search\?q=bo&limit=20$/);
  assert.deepEqual(page, { items: [{ id: 5, username: "bob", displayName: "Bob", accountType: "human", provisioned: true }], page: 1, hasMore: false, degraded: true });
});

test("directory errors other than 404 surface instead of silently falling back", async () => {
  const f = stubFetch([[500, { code: 500, message: "directory search failed" }]]);
  try { await assert.rejects(searchDirectory("bo", session), /directory search failed/); } finally { f.restore(); }
});

test("picking a portal-only user provisions once; provisioned users skip the call", async () => {
  const f = stubFetch([[200, { code: 0, message: "success", data: { id: 42 } }]]);
  try {
    const contact = await provisionContact({ id: 0, portalUid: 7, username: "", displayName: "Ann", accountType: "human", provisioned: false }, session);
    assert.deepEqual(contact, { id: 42, username: "", displayName: "Ann", accountType: "human" });
    const known = { id: 5, username: "bob", displayName: "Bob", accountType: "human" as const, provisioned: true };
    assert.equal(await provisionContact(known, session), known);
  } finally { f.restore(); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, "POST");
  assert.match(f.calls[0].url, /\/api\/v1\/addons\/auth\/directory\/provision$/);
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { portalUid: 7 });
});

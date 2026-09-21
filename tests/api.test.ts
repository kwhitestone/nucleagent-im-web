import assert from "node:assert/strict";
import test from "node:test";
import {
  addGroupMembers,
  createGroup,
  getAgentAllowlist,
  getGroupMembers,
  listGroups,
  removeGroupMember,
  replaceAgentAllowlist,
  searchContacts,
  type ConnectSession,
} from "../src/api.ts";

const session: ConnectSession = { uid: "1", token: "im", wsAddr: "ws://im", jwt: "jwt" };

test("contact and group APIs use the landed method, path, and body contracts", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ code: 0, message: "success", data: {} }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  try {
    await searchContacts("agent", session, 5);
    await listGroups(session);
    await createGroup("Team", [2, 3], session);
    await getGroupMembers(9, session);
    await addGroupMembers(9, [4], session);
    await removeGroupMember(9, 4, session);
    await getAgentAllowlist(9, 3, session);
    await replaceAgentAllowlist(9, 3, [2, 4], session);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.match(calls[0].url, /\/api\/v1\/addons\/auth\/contacts\/search\?q=agent&limit=5$/);
  assert.equal(calls[0].init.method, undefined);
  assert.match(calls[1].url, /\/api\/v1\/im\/groups$/);
  assert.equal(calls[2].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { title: "Team", memberUids: [2, 3] });
  assert.match(calls[3].url, /\/api\/v1\/im\/groups\/9\/members$/);
  assert.equal(calls[4].init.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[4].init.body)), { memberUids: [4] });
  assert.equal(calls[5].init.method, "DELETE");
  assert.match(calls[5].url, /\/api\/v1\/im\/groups\/9\/members\/4$/);
  assert.equal(calls[6].init.method, undefined);
  assert.match(calls[6].url, /\/api\/v1\/im\/groups\/9\/agents\/3\/allowlist$/);
  assert.equal(calls[7].init.method, "PUT");
  assert.deepEqual(JSON.parse(String(calls[7].init.body)), { memberUids: [2, 4] });
  assert.equal((calls[7].init.headers as Record<string, string>).Authorization, "Bearer jwt");
});

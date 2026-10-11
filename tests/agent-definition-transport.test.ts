import assert from "node:assert/strict";
import { test } from "node:test";
import { sessionTransport } from "../src/agent-definition/transport.ts";
test("Core uses current user's raw JWT, timeout, no cookies, preserves ETag", async () => {
  const session = { uid: "4", jwt: "test-access" };
  let sent: any;
  const transport = sessionTransport("https://core.example.test", () => session, async (url, init) => {
    sent = { url, init }; return new Response('{"code":0,"data":{}}', { headers: { ETag: '"agent-4-1"' } });
  });
  const result = await transport("/api/v1/addons/admin/agents/4", { headers: { "If-Match": '"agent-4-1"' } });
  assert.equal(sent.url, "https://core.example.test/api/v1/addons/admin/agents/4");
  assert.equal(sent.init.headers.get("Authorization"), "test-access");
  assert.equal(sent.init.headers.get("If-Match"), '"agent-4-1"');
  assert.equal(sent.init.credentials, "omit");
  assert.ok(sent.init.signal);
  assert.equal(result.headers.etag, '"agent-4-1"');
});
test("session switches reject stale results and missing origins never fall back to another backend", async () => {
  let session = { uid: "4", jwt: "first" };
  const transport = sessionTransport("https://core.example.test", () => session, async () => {
    session = { uid: "8", jwt: "next" }; return new Response('{"code":0,"data":{}}');
  });
  await assert.rejects(transport("/api/v1/addons/admin/agents/catalog"), /session_changed/);
  for (const base of ["", "https://user:pass@example.test", "https://core.example.test/path", "javascript:evil"]) {
    let called = false;
    await assert.rejects(sessionTransport(base, () => session, async () => { called = true; return new Response(); })("/api/v1/addons/admin/agents/catalog"));
    assert.equal(called, false);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { refreshSession } from "../src/api.ts";

type Call = { url: string; init: RequestInit };

function envelope(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function stubFetch(handler: (call: Call) => Response): { calls: Call[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init = {}) => {
    const call = { url: String(input), init };
    calls.push(call);
    return handler(call);
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

// The refresh cookie is HttpOnly and outlives the document, so boot can rebuild the
// session without a login. This is the P0 happy path.
test("a valid refresh cookie mints a session with the cookie and a request id attached", async () => {
  const stub = stubFetch(({ url }) =>
    url.includes("/refresh-token")
      ? envelope({ code: 0, message: "success", data: { accessToken: "rotated-jwt" } })
      : envelope({ code: 0, message: "success", data: { uid: "2", token: "im", wsAddr: "ws://im" } }));

  try {
    const session = await refreshSession();
    assert.deepEqual(session, { uid: "2", token: "im", wsAddr: "ws://im", jwt: "rotated-jwt" });
  } finally {
    stub.restore();
  }

  const [refresh, connect] = stub.calls;
  assert.match(refresh.url, /\/api\/v1\/addons\/auth\/refresh-token$/);
  assert.equal(refresh.init.method, "POST");
  // Without the cookie the server has no credential to rotate.
  assert.equal(refresh.init.credentials, "include");
  const headers = refresh.init.headers as Record<string, string>;
  assert.equal(headers["X-Refresh-Cookie-Only"], "1");
  // The server rejects a cookie-only refresh whose request id is outside 16..128 chars.
  assert.ok(headers["X-Refresh-Request-ID"].length >= 16);
  assert.ok(headers["X-Refresh-Request-ID"].length <= 128);
  assert.match(connect.url, /\/api\/v1\/im\/connect-token$/);
});

// No cookie, an expired one, or a revoked family: boot must fall through to the login
// form instead of hanging or surfacing a crash.
test("a rejected refresh rejects so boot can fall back to the login form", async () => {
  const stub = stubFetch(() => envelope({ code: 1, message: "刷新令牌无效或已过期" }, 401));
  try {
    await assert.rejects(refreshSession(), /刷新令牌无效或已过期/);
  } finally {
    stub.restore();
  }
  // It must not have attempted the IM handoff on a failed rotation.
  assert.equal(stub.calls.length, 1);
});

// The server rotates on every call and treats a second call bearing a *different*
// request id as reuse, revoking the whole family. Boot restore and the stream's expiry
// refresh can fire together, so concurrent callers must share one rotation.
test("concurrent refreshes issue a single rotation instead of tripping reuse detection", async () => {
  const stub = stubFetch(({ url }) =>
    url.includes("/refresh-token")
      ? envelope({ code: 0, message: "success", data: { accessToken: "rotated-jwt" } })
      : envelope({ code: 0, message: "success", data: { uid: "2", token: "im", wsAddr: "ws://im" } }));

  try {
    const [first, second] = await Promise.all([refreshSession(), refreshSession()]);
    assert.deepEqual(first, second);
  } finally {
    stub.restore();
  }

  const rotations = stub.calls.filter((call) => call.url.includes("/refresh-token"));
  assert.equal(rotations.length, 1);
});

// A shared in-flight promise must not become a permanently cached one: after it settles,
// the next refresh has to hit the server for a genuinely new token.
test("a later refresh rotates again once the in-flight call has settled", async () => {
  const stub = stubFetch(({ url }) =>
    url.includes("/refresh-token")
      ? envelope({ code: 0, message: "success", data: { accessToken: "rotated-jwt" } })
      : envelope({ code: 0, message: "success", data: { uid: "2", token: "im", wsAddr: "ws://im" } }));

  try {
    await refreshSession();
    await refreshSession();
  } finally {
    stub.restore();
  }

  assert.equal(stub.calls.filter((call) => call.url.includes("/refresh-token")).length, 2);
});

// A failed rotation must not be latched either, or a user who fixes their connection
// could never retry without a reload.
test("a failed refresh clears the shared promise so a retry is possible", async () => {
  let attempt = 0;
  const stub = stubFetch(({ url }) => {
    if (url.includes("/refresh-token")) {
      attempt += 1;
      return attempt === 1
        ? envelope({ code: 1, message: "刷新令牌无效或已过期" }, 401)
        : envelope({ code: 0, message: "success", data: { accessToken: "rotated-jwt" } });
    }
    return envelope({ code: 0, message: "success", data: { uid: "2", token: "im", wsAddr: "ws://im" } });
  });

  try {
    await assert.rejects(refreshSession());
    const session = await refreshSession();
    assert.equal(session.jwt, "rotated-jwt");
  } finally {
    stub.restore();
  }
  assert.equal(attempt, 2);
});

import assert from "node:assert/strict";
import test from "node:test";
import {
  callbackPath,
  completePortalLogin,
  isCallbackPath,
  readCallback,
  startPortalLogin,
} from "../src/portal.ts";

const state = "a".repeat(64);

function fakeLocation(url: string): Location {
  const parsed = new URL(url, "https://im.example.com");
  return {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  } as Location;
}

function fakeHistory(): { history: History; calls: string[] } {
  const calls: string[] = [];
  const history = {
    replaceState(_data: unknown, _unused: string, url?: string | URL | null) {
      calls.push(String(url));
    },
  } as History;
  return { history, calls };
}

function stubFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  let index = 0;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("the callback strips the credential from the URL before returning it", () => {
  const { history, calls } = fakeHistory();
  const callback = readCallback(
    fakeLocation(`${callbackPath}?state=${state}&token=portal-secret`),
    history,
  );

  assert.deepEqual(callback, { state, token: "portal-secret" });
  // The scrub must happen unconditionally and leave no query behind.
  assert.deepEqual(calls, ["/"]);
});

// Field report (UNI-B0c): after SSO the address bar stayed on /auth/portal, so a
// reload skipped boot restore (App.vue gates it on !isCallbackPath) and re-entered
// the callback with a consumed state -> errCancelled. Every path must leave a URL
// whose reload takes the normal refresh-cookie boot.
test("after any callback load, a reload is not a callback load", () => {
  for (const url of [
    `${callbackPath}?state=${state}&token=portal-secret`,
    `${callbackPath}?state=${state}&token=already-consumed`,
    `${callbackPath}?state=garbage&token=x`,
    callbackPath,
  ]) {
    const { history, calls } = fakeHistory();
    readCallback(fakeLocation(url), history);
    assert.equal(calls.length, 1, url);
    assert.equal(isCallbackPath(fakeLocation(calls[0])), false, url);
  }
});

test("the callback also accepts the credential in the fragment", () => {
  const { history } = fakeHistory();
  const callback = readCallback(
    fakeLocation(`${callbackPath}#state=${state}&token=frag-secret`),
    history,
  );

  assert.deepEqual(callback, { state, token: "frag-secret" });
});

test("a denied or malformed callback yields no credential but still scrubs the URL", () => {
  for (const url of [
    `${callbackPath}?error=access_denied`,
    `${callbackPath}?state=${state}`,
    `${callbackPath}?token=orphan`,
    `${callbackPath}?state=short&token=orphan`,
  ]) {
    const { history, calls } = fakeHistory();
    assert.equal(readCallback(fakeLocation(url), history), undefined, url);
    assert.deepEqual(calls, ["/"], url);
  }
});

test("only the callback route is treated as a portal return", () => {
  assert.equal(isCallbackPath(fakeLocation(callbackPath)), true);
  assert.equal(isCallbackPath(fakeLocation("/")), false);
});

test("start posts an empty object with the flow cookie and returns the login URL", async () => {
  const { calls, restore } = stubFetch([
    { status: 200, body: { code: 0, message: "success", data: { loginUrl: "https://portal/login?redirect=x" } } },
  ]);

  try {
    assert.equal(await startPortalLogin(), "https://portal/login?redirect=x");
  } finally {
    restore();
  }

  assert.match(calls[0].url, /\/api\/v1\/addons\/auth\/portal\/start$/);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.credentials, "include");
  assert.equal(String(calls[0].init.body), "{}");
});

test("a disabled or origin-rejected start surfaces the server message", async () => {
  for (const response of [
    { status: 404, body: { code: 404, message: "portal login is disabled" } },
    { status: 403, body: { code: 403, message: "portal login origin rejected" } },
  ]) {
    const { restore } = stubFetch([response]);
    try {
      await assert.rejects(startPortalLogin(), new RegExp(response.body.message));
    } finally {
      restore();
    }
  }
});

test("callback success exchanges the credential and reaches an authed IM session", async () => {
  const { calls, restore } = stubFetch([
    { status: 200, body: { code: 0, message: "success", data: { accessToken: "local-jwt" } } },
    { status: 200, body: { code: 0, message: "success", data: { uid: "7", token: "im", wsAddr: "ws://im" } } },
  ]);

  try {
    const session = await completePortalLogin({ state, token: "portal-secret" });
    assert.deepEqual(session, { uid: "7", token: "im", wsAddr: "ws://im", jwt: "local-jwt" });
  } finally {
    restore();
  }

  assert.match(calls[0].url, /\/api\/v1\/addons\/auth\/portal\/login$/);
  assert.equal(calls[0].init.credentials, "include");
  const headers = calls[0].init.headers as Record<string, string>;
  assert.equal(headers["X-Refresh-Cookie-Only"], "1");
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    state,
    credential: "portal-secret",
  });
  // The portal credential must never appear in a URL.
  assert.ok(calls.every((call) => !call.url.includes("portal-secret")));
  // Completion reuses the shared local-login handoff, not a second contract.
  assert.match(calls[1].url, /\/api\/v1\/im\/connect-token$/);
  assert.equal((calls[1].init.headers as Record<string, string>).Authorization, "Bearer local-jwt");
});

test("state mismatch and replay report the server reason instead of a blank page", async () => {
  for (const response of [
    { status: 401, body: { code: 401, message: "invalid portal login state" } },
    { status: 401, body: { code: 401, message: "expired or consumed portal login state" } },
    { status: 401, body: { code: 401, message: "portal identity verification failed" } },
    { status: 503, body: { code: 503, message: "portal login unavailable" } },
  ]) {
    const { restore } = stubFetch([response]);
    try {
      await assert.rejects(
        completePortalLogin({ state, token: "portal-secret" }),
        new RegExp(response.body.message),
      );
    } finally {
      restore();
    }
  }
});

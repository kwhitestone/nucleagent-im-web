import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCachedProfile,
  fetchProfile,
  isPlaceholderName,
  loadCachedProfile,
  saveCachedProfile,
} from "../src/profile.ts";
import type { ConnectSession } from "../src/api.ts";

const session: ConnectSession = {
  uid: "10480118",
  token: "im-token",
  wsAddr: "ws://127.0.0.1:5200",
  jwt: "access-token",
};

function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return run().finally(() => {
    globalThis.fetch = original;
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function withStorage(run: () => void): void {
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => void data.set(key, value),
      removeItem: (key: string) => void data.delete(key),
    },
  });
  try {
    run();
  } finally {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  }
}

// --- happy path --------------------------------------------------------------

test("a real nickname and avatar are read from the auth profile", async () => {
  await withFetch(
    async (input, init) => {
      assert.match(String(input), /\/api\/v1\/addons\/auth\/user-info$/);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "access-token",
      );
      return json({ code: 0, message: "ok", data: { id: 1, username: "chenmo", nickName: "陈默", headerImg: "https://example.test/a.png" } });
    },
    async () => {
      const profile = await fetchProfile(session);
      assert.deepEqual(profile, { displayName: "陈默", avatar: "https://example.test/a.png" });
    },
  );
});

test("a blank nickname falls back to the username, matching the shell", async () => {
  await withFetch(
    async () => json({ code: 0, message: "ok", data: { username: "chenmo", nickName: "", headerImg: "" } }),
    async () => {
      assert.equal((await fetchProfile(session))?.displayName, "chenmo");
    },
  );
});

/**
 * The reported symptom. auth's portal exchange decodes only {id, openId} from
 * the portal response and invents "Portal user <id>", so this string is a
 * placeholder rather than a name the user chose. Treating it as absent lets the
 * identity card show its own clearer fallback instead of presenting made-up
 * data as real. The random "portal_<uuid>" username is no better.
 */
test("auth's invented Portal user placeholder is treated as no name at all", async () => {
  await withFetch(
    async () => json({
      code: 0,
      message: "ok",
      data: { username: "portal_9f1c2d3e", nickName: "Portal user 1", headerImg: "" },
    }),
    async () => {
      assert.equal(await fetchProfile(session), undefined);
    },
  );
});

test("the placeholder pattern matches only auth's generated form", () => {
  assert.ok(isPlaceholderName("Portal user 1"));
  assert.ok(isPlaceholderName("Portal user 10480118"));
  // A human who happens to be called something similar keeps their name.
  assert.ok(!isPlaceholderName("Portal user Chen"));
  assert.ok(!isPlaceholderName("陈默"));
});

// --- broken paths ------------------------------------------------------------
// A display name is never worth failing a sign-in over: every one of these
// resolves to undefined so the identity card falls back to the UID.

test("a rejected, unreachable or malformed profile never throws", async () => {
  await withFetch(async () => json({ code: 401, message: "unauthorized" }, 401), async () => {
    assert.equal(await fetchProfile(session), undefined);
  });
  await withFetch(async () => { throw new TypeError("network down"); }, async () => {
    assert.equal(await fetchProfile(session), undefined);
  });
  await withFetch(async () => new Response("<html>gateway</html>", { status: 200 }), async () => {
    assert.equal(await fetchProfile(session), undefined);
  });
  // A 200 carrying a non-zero envelope code is a failure, not an empty profile.
  await withFetch(async () => json({ code: 7, message: "nope", data: { nickName: "x" } }), async () => {
    assert.equal(await fetchProfile(session), undefined);
  });
  await withFetch(async () => json({ code: 0, message: "ok" }), async () => {
    assert.equal(await fetchProfile(session), undefined);
  });
});

test("an avatar alone is still a profile worth keeping", async () => {
  await withFetch(
    async () => json({ code: 0, message: "ok", data: { username: "portal_9f1c", nickName: "Portal user 1", headerImg: "https://example.test/a.png" } }),
    async () => {
      assert.deepEqual(await fetchProfile(session), {
        displayName: "",
        avatar: "https://example.test/a.png",
      });
    },
  );
});

// --- cache -------------------------------------------------------------------

test("the profile is cached per account and cleared on sign-out", () => {
  withStorage(() => {
    saveCachedProfile("10480118", { displayName: "陈默", avatar: "" });
    assert.equal(loadCachedProfile("10480118")?.displayName, "陈默");
    // Another account on the same browser must not inherit this name — the
    // shell can swap users by pushing a token with no sign-out in between.
    assert.equal(loadCachedProfile("10480999"), undefined);
    clearCachedProfile("10480118");
    assert.equal(loadCachedProfile("10480118"), undefined);
  });
});

test("a corrupt cached profile degrades to undefined rather than throwing", () => {
  withStorage(() => {
    globalThis.localStorage.setItem("im-web.profile.10480118", "{not json");
    assert.equal(loadCachedProfile("10480118"), undefined);
    globalThis.localStorage.setItem("im-web.profile.10480118", '{"displayName":42}');
    assert.equal(loadCachedProfile("10480118"), undefined);
  });
});

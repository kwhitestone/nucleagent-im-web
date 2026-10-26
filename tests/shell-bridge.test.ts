import assert from "node:assert/strict";
import test from "node:test";
import { installShellBridge, isInShell, parseShellAuth, shellAccountUrl } from "../src/shell.ts";
import { runtimeFixture } from "./fixtures/runtimeConfig.ts";

const shellOrigin = runtimeFixture().VITE_SHELL_URL;
const token = "access-token";

function authPayload(overrides: Record<string, unknown> = {}) {
  return { source: "shell", type: "auth", token, sessionVersion: 1, ...overrides };
}

test("a valid shell auth intent is accepted once the version moves forward", () => {
  assert.deepEqual(parseShellAuth(authPayload(), 0), { token, sessionVersion: 1 });
  assert.deepEqual(parseShellAuth(authPayload({ sessionVersion: 7 }), 7), { token, sessionVersion: 7 });
});

test("a forged source or type is rejected", () => {
  assert.equal(parseShellAuth(authPayload({ source: "sub" }), 0), null);
  assert.equal(parseShellAuth(authPayload({ source: undefined }), 0), null);
  assert.equal(parseShellAuth(authPayload({ type: "locale" }), 0), null);
  assert.equal(parseShellAuth(null, 0), null);
  assert.equal(parseShellAuth([authPayload()], 0), null);
  assert.equal(parseShellAuth("token", 0), null);
});

test("a stale session version is rejected in both directions", () => {
  assert.equal(parseShellAuth(authPayload({ sessionVersion: 2 }), 5), null);
  assert.equal(parseShellAuth(authPayload({ token: null, sessionVersion: 2 }), 5), null);
  assert.equal(parseShellAuth(authPayload({ sessionVersion: -1 }), 0), null);
  assert.equal(parseShellAuth(authPayload({ sessionVersion: 1.5 }), 0), null);
  assert.equal(parseShellAuth(authPayload({ sessionVersion: "1" }), 0), null);
});

test("an oversized, empty, or non-string token is rejected", () => {
  assert.equal(parseShellAuth(authPayload({ token: "x".repeat(8193) }), 0), null);
  assert.equal(parseShellAuth(authPayload({ token: "" }), 0), null);
  assert.equal(parseShellAuth(authPayload({ token: 42 }), 0), null);
  assert.equal(parseShellAuth(authPayload({ permissions: "all" }), 0), null);
  assert.equal(parseShellAuth(authPayload({ permissions: new Array(513).fill("p") }), 0), null);
});

test("a null token at the current version is a logout, not a rejection", () => {
  assert.deepEqual(parseShellAuth(authPayload({ token: null, sessionVersion: 3 }), 3), {
    token: null,
    sessionVersion: 3,
  });
});

/** Minimal window/parent pair: a framed document whose parent is the shell. */
function framedWindow() {
  const sent: Array<{ message: any; targetOrigin: string }> = [];
  const listeners: Array<(event: any) => void> = [];
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      sent.push({ message, targetOrigin });
    },
  };
  const window = {
    parent,
    addEventListener(_type: string, handler: (event: any) => void) {
      listeners.push(handler);
    },
    removeEventListener(_type: string, handler: (event: any) => void) {
      const index = listeners.indexOf(handler);
      if (index >= 0) listeners.splice(index, 1);
    },
  };
  const deliver = (event: unknown) => listeners.forEach((handler) => handler(event));
  return { window, parent, sent, deliver, listenerCount: () => listeners.length };
}

function hostEnvelope(type: string, payload: unknown, overrides: Record<string, unknown> = {}) {
  return {
    protocol: "prism-fusion/remote",
    version: 1,
    appId: "im",
    instanceId: "0123456789abcdef-0000",
    type,
    payload,
    ...overrides,
  };
}

function withFramedWindow<T>(run: (frame: ReturnType<typeof framedWindow>) => T): T {
  const frame = framedWindow();
  const original = (globalThis as any).window;
  (globalThis as any).window = frame.window;
  try {
    return run(frame);
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
}

test("standalone im-web installs no bridge and reports no shell", () => {
  const original = (globalThis as any).window;
  const self: any = {};
  self.parent = self;
  (globalThis as any).window = self;
  try {
    assert.equal(isInShell(), false);
    const bridge = installShellBridge({ onAuth: () => assert.fail("must not receive auth") });
    assert.equal(bridge.requestLogin(), false);
    assert.equal(bridge.requestAccount(), false);
    assert.equal(bridge.reportAuthRequired("missing"), false);
    bridge.dispose();
  } finally {
    if (original === undefined) delete (globalThis as any).window;
    else (globalThis as any).window = original;
  }
});

test("the shell handshake hands the pushed session to the child", () => {
  withFramedWindow((frame) => {
    const received: Array<string | null> = [];
    const bridge = installShellBridge({ onAuth: (intent) => received.push(intent.token) });

    // Nothing is acknowledged before host:init: the child has no instance id.
    assert.deepEqual(frame.sent, []);
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    assert.equal(frame.sent.length, 1);
    assert.equal(frame.sent[0].message.type, "child:ready");
    assert.equal(frame.sent[0].targetOrigin, shellOrigin);

    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", authPayload()) });
    assert.deepEqual(received, [token]);

    // Logout arrives as a null token on the same or a later version.
    frame.deliver({
      source: frame.parent,
      origin: shellOrigin,
      data: hostEnvelope("auth", authPayload({ token: null, sessionVersion: 2 })),
    });
    assert.deepEqual(received, [token, null]);

    // The AccountPopover's two exits both go to the shell (UNI-ACCTUI).
    assert.equal(bridge.requestAccount(), true);
    assert.equal(frame.sent.at(-1)?.message.type, "account-request");
    assert.equal(bridge.requestLogout(), true);
    assert.equal(frame.sent.at(-1)?.message.type, "logout-request");
    assert.equal(bridge.requestLogin(), true);
    assert.equal(frame.sent.at(-1)?.message.type, "login-request");
    assert.equal(bridge.reportAuthRequired("rejected"), true);
    assert.equal(frame.sent.at(-1)?.message.payload.sessionVersion, 2);

    bridge.dispose();
    assert.equal(frame.listenerCount(), 0);
  });
});

test("a message from a foreign origin, source, app, or protocol version never reaches the child", () => {
  withFramedWindow((frame) => {
    const received: unknown[] = [];
    installShellBridge({ onAuth: (intent) => received.push(intent) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });

    const attacks = [
      // Right shape, wrong origin — an attacker frame or a look-alike host.
      { source: frame.parent, origin: "https://evil.example.com", data: hostEnvelope("auth", authPayload()) },
      { source: frame.parent, origin: "http://localhost:26601", data: hostEnvelope("auth", authPayload()) },
      // Right origin, wrong window — a nested iframe posting as the parent.
      { source: {}, origin: shellOrigin, data: hostEnvelope("auth", authPayload()) },
      // Another app's channel, or a future protocol.
      { source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", authPayload(), { appId: "core" }) },
      { source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", authPayload(), { version: 2 }) },
      // A different host instance than the one that shook hands.
      {
        source: frame.parent,
        origin: shellOrigin,
        data: hostEnvelope("auth", authPayload(), { instanceId: "fedcba9876543210-1111" }),
      },
      // Undeclared inbound capability, and a bare non-envelope post.
      { source: frame.parent, origin: shellOrigin, data: hostEnvelope("view", { source: "shell", type: "view" }) },
      { source: frame.parent, origin: shellOrigin, data: { token, sessionVersion: 9 } },
    ];
    for (const attack of attacks) frame.deliver(attack);

    assert.deepEqual(received, []);
  });
});

test("standalone, the account action goes to the shell's /account and back to /im", () => {
  const url = new URL(shellAccountUrl());
  assert.equal(url.origin, shellOrigin);
  assert.equal(url.pathname, "/account");
  assert.equal(url.searchParams.get("redirect"), "/im");
});

test("conversation targets require the authenticated session and validated channel", () => {
  withFramedWindow((frame) => {
    const received: unknown[] = [];
    const bridge = installShellBridge({ onAuth() {}, onConversation: (target) => received.push(target) });
    const target = { channelId: "11@17", channelType: 1, agentUid: "17" };
    const send = (type: string, payload: unknown, envelope = {}, event = {}) => frame.deliver({
      source: frame.parent, origin: shellOrigin, data: hostEnvelope(type, payload, envelope), ...event,
    });
    const intent = (sessionVersion: number, overrides = {}) => ({
      source: "shell", type: "conversation", sessionVersion, target, ...overrides,
    });
    send("host:init", undefined);
    send("conversation", intent(0));
    assert.deepEqual(received, []);
    send("auth", authPayload());
    for (const event of [{ origin: "https://evil.example" }, { source: {} }]) {
      send("conversation", intent(1), {}, event);
    }
    for (const envelope of [{ appId: "core" }, { instanceId: "fedcba9876543210-1111" }, { version: 2 }]) {
      send("conversation", intent(1), envelope);
    }
    send("conversation", intent(0));
    send("conversation", intent(2));
    send("conversation", intent(1, { source: "sub" }));
    send("conversation", intent(1, { target: { ...target, channelId: "17@11" } }));
    assert.deepEqual(received, []);
    send("conversation", intent(1));
    assert.deepEqual(received, [target]);
    send("auth", authPayload({ token: null }));
    send("conversation", intent(1));
    assert.deepEqual(received, [target]);
    bridge.dispose();
  });
});

// MUYU-161: real DEV trace (2026-10-27 03:19:16) of a same-origin second tab renewing:
// the shell delivered every auth intent twice — revalidation 2143→2144 ×2, then the proven
// token at 2144 ×2. The duplicate revalidation used to fall through as a null-token sign-out
// and tore the IM view down (draft, channel, history).
test("a duplicated revalidation delivery is not a sign-out; the proven token resumes", () => {
  withFramedWindow((frame) => {
    const received: Array<{ token: string | null; sessionVersion: number; revalidating?: true }> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 2143 }));
    const reval = { source: "shell", type: "auth", token: null, sessionVersion: 2144, principal: null, permissions: [], revalidation: { previousVersion: 2143 } };
    send(reval);
    send(reval);
    send(authPayload({ sessionVersion: 2144, token: "proven" }));
    send(authPayload({ sessionVersion: 2144, token: "proven" }));
    assert.deepEqual(received.map((x) => [x.token, x.sessionVersion, !!x.revalidating]), [
      [token, 2143, false],
      [null, 2144, true],
      ["proven", 2144, false],
      ["proven", 2144, false],
    ]);
  });
});

test("after a revalidation resolves, a stale revalidation replay or a real sign-out still signs out", () => {
  withFramedWindow((frame) => {
    const received: Array<{ token: string | null; revalidating?: true }> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 5 }));
    const reval = { source: "shell", type: "auth", token: null, sessionVersion: 6, revalidation: { previousVersion: 5 } };
    send(reval);
    send(authPayload({ sessionVersion: 6, token: "proven" }));
    // A late duplicate copy of the same revalidation (same version) after the proven
    // token is still that revalidation: ignored, not a sign-out.
    send(reval);
    assert.deepEqual(received.map((x) => [x.token, !!x.revalidating]), [[token, false], [null, true], ["proven", false]]);
    // Once the session has moved on, replaying that old revalidation signs out.
    send(authPayload({ sessionVersion: 7 }));
    const seen = received.length;
    send(reval);
    assert.equal(received.length, seen, "stale (version < held) is rejected outright");
    // A real sign-out at the held version is honoured.
    send({ source: "shell", type: "auth", token: null, sessionVersion: 7 });
    assert.deepEqual(received.at(-1), { token: null, sessionVersion: 7 });
    // A revalidation that does not start from the held version stays a sign-out.
    send({ source: "shell", type: "auth", token: null, sessionVersion: 8, revalidation: { previousVersion: 3 } });
    assert.deepEqual(received.at(-1), { token: null, sessionVersion: 8 });
  });
});

test("a duplicate revalidation arriving after the proven token is still ignored", () => {
  withFramedWindow((frame) => {
    const received: Array<{ token: string | null; revalidating?: true }> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 10 }));
    const reval = { source: "shell", type: "auth", token: null, sessionVersion: 11, revalidation: { previousVersion: 10 } };
    send(reval);
    send(authPayload({ sessionVersion: 11, token: "proven" }));
    send(reval); // non-adjacent duplicate
    send(authPayload({ sessionVersion: 11, token: "proven" }));
    assert.deepEqual(received.map((x) => [x.token, !!x.revalidating]), [[token, false], [null, true], ["proven", false], ["proven", false]]);
  });
});

test("a real sign-out at the same version right after a resolved revalidation still signs out", () => {
  withFramedWindow((frame) => {
    const received: Array<{ token: string | null; sessionVersion: number; revalidating?: true }> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 20 }));
    send({ source: "shell", type: "auth", token: null, sessionVersion: 21, revalidation: { previousVersion: 20 } });
    send(authPayload({ sessionVersion: 21, token: "proven" }));
    send({ source: "shell", type: "auth", token: null, sessionVersion: 21 }); // no revalidation marker
    assert.deepEqual(received.at(-1), { token: null, sessionVersion: 21 });
  });
});

// MUYU-161 verifier finding: after a sign-out at version V, a late (duplicated) copy of the
// V credential was accepted and revived the session. The sign-out is now a version barrier.
test("a late same-version credential after a sign-out never revives the session", () => {
  withFramedWindow((frame) => {
    const received: Array<string | null> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent.token) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 5, token: "old" }));
    send({ source: "shell", type: "auth", token: null, sessionVersion: 5 }); // sign-out at the same version
    send(authPayload({ sessionVersion: 5, token: "old" }));                 // late duplicate copy
    send(authPayload({ sessionVersion: 4, token: "older" }));               // stale
    assert.deepEqual(received, ["old", null], "nothing after the sign-out is accepted");
    send(authPayload({ sessionVersion: 6, token: "fresh-login" }));         // a real new sign-in
    assert.deepEqual(received, ["old", null, "fresh-login"]);
  });
});

test("the barrier also holds when the sign-out advanced the version", () => {
  withFramedWindow((frame) => {
    const received: Array<string | null> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent.token) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 7, token: "a" }));
    send({ source: "shell", type: "auth", token: null, sessionVersion: 8 });
    send(authPayload({ sessionVersion: 8, token: "a" }));
    send(authPayload({ sessionVersion: 8, token: "a" }));
    assert.deepEqual(received, ["a", null]);
  });
});

test("a revalidation is not a sign-out: its same-version proven token (and duplicates) still resume", () => {
  withFramedWindow((frame) => {
    const received: Array<[string | null, boolean]> = [];
    installShellBridge({ onAuth: (intent) => received.push([intent.token, !!intent.revalidating]) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 30, token: "t30" }));
    const reval = { source: "shell", type: "auth", token: null, sessionVersion: 31, revalidation: { previousVersion: 30 } };
    send(reval); send(reval);
    send(authPayload({ sessionVersion: 31, token: "t31" }));
    send(authPayload({ sessionVersion: 31, token: "t31" }));
    assert.deepEqual(received, [["t30", false], [null, true], ["t31", false], ["t31", false]]);
    // ...and a real sign-out after that is still a barrier for the same version.
    send({ source: "shell", type: "auth", token: null, sessionVersion: 31 });
    send(authPayload({ sessionVersion: 31, token: "t31" }));
    assert.deepEqual(received.at(-1), [null, false]);
  });
});

test("account switch (regression guard, held by the version order, not the new barrier): the old user's late credential cannot replace the new user's session", () => {
  withFramedWindow((frame) => {
    const received: Array<string | null> = [];
    installShellBridge({ onAuth: (intent) => received.push(intent.token) });
    const send = (payload: unknown) => frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("auth", payload) });
    frame.deliver({ source: frame.parent, origin: shellOrigin, data: hostEnvelope("host:init", undefined) });
    send(authPayload({ sessionVersion: 40, token: "user-a" }));
    send({ source: "shell", type: "auth", token: null, sessionVersion: 41 });
    send(authPayload({ sessionVersion: 42, token: "user-b" }));
    send(authPayload({ sessionVersion: 40, token: "user-a" })); // late copy of the old user
    send(authPayload({ sessionVersion: 41, token: "user-a" }));
    assert.deepEqual(received, ["user-a", null, "user-b"]);
  });
});

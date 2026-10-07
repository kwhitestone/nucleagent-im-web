import assert from "node:assert/strict";
import test from "node:test";
import { installShellBridge, isInShell, parseShellAuth, shellAccountUrl } from "../src/shell.ts";

const shellOrigin = "http://localhost:26600";
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

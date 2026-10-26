// MUYU-161: a shell cross-tab revalidation is not a sign-out, and an embedded agent
// stream never retries a token the server already rejected.
import assert from "node:assert/strict";
import test from "node:test";
import { nextShellCredential, parseShellAuth } from "../src/shell.ts";

const revalidation = (previousVersion: unknown, sessionVersion: number) =>
  ({ source: "shell", type: "auth", token: null, sessionVersion, principal: null, permissions: [], revalidation: { previousVersion } });

test("a revalidation from exactly the held version is recognised, not a sign-out", () => {
  assert.deepEqual(parseShellAuth(revalidation(7, 8), 7), { token: null, sessionVersion: 8, revalidating: true });
});

test("anything else shaped like a revalidation still fails closed as a sign-out", () => {
  // From another version than the one this child holds: no snapshot to keep.
  assert.deepEqual(parseShellAuth(revalidation(6, 8), 7), { token: null, sessionVersion: 8 });
  // Not moving forward.
  assert.deepEqual(parseShellAuth(revalidation(7, 7), 7), { token: null, sessionVersion: 7 });
  // A child that never held a session has nothing to keep.
  assert.deepEqual(parseShellAuth(revalidation(0, 1), 0), { token: null, sessionVersion: 1 });
  // Malformed markers.
  for (const marker of [null, [], "7", { previousVersion: "7" }]) {
    assert.deepEqual(parseShellAuth({ ...revalidation(7, 8), revalidation: marker }, 7), { token: null, sessionVersion: 8 });
  }
  // A token-bearing intent is a normal auth, never a revalidation.
  assert.deepEqual(parseShellAuth({ ...revalidation(7, 8), token: "t" }, 7), { token: "t", sessionVersion: 8 });
  // Stale versions are still rejected outright.
  assert.equal(parseShellAuth(revalidation(7, 5), 7), null);
});

const instant = { sleep: async () => {}, stepMs: 1, timeoutMs: 5 };

test("stream retry takes the newer token the shell already pushed, without asking", async () => {
  let asked = 0;
  assert.equal(await nextShellCredential(() => "fresh", "rejected", () => asked++, instant), "fresh");
  assert.equal(asked, 0);
});

test("stream retry asks once and waits for the shell push", async () => {
  let current = "rejected", asked = 0, ticks = 0;
  const got = await nextShellCredential(() => current, "rejected", () => asked++, {
    ...instant, timeoutMs: 50, sleep: async () => { if (++ticks === 3) current = "pushed"; },
  });
  assert.equal(got, "pushed");
  assert.equal(asked, 1);
});

test("stream retry never reuses the rejected token and gives up when nothing new arrives", async () => {
  let asked = 0;
  await assert.rejects(nextShellCredential(() => "rejected", "rejected", () => asked++, instant));
  assert.equal(asked, 1);
});

test("stream retry stops at once on sign-out or a different user (read returns nothing)", async () => {
  let current: string | undefined = "rejected", ticks = 0;
  await assert.rejects(nextShellCredential(() => current, "rejected", () => {}, {
    ...instant, timeoutMs: 1000, sleep: async () => { ticks++; current = undefined; },
  }));
  assert.equal(ticks, 1);
});

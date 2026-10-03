import assert from "node:assert/strict";
import test from "node:test";
import type { ConnectSession } from "../src/api.ts";
import { accountTypeOf, avatarFor, ensureNames, handleFor, isEnterprise, isMissing, isRealName, nameFor, resetNames } from "../src/names.ts";

const alice: ConnectSession = { uid: "1", token: "im", wsAddr: "ws://im", jwt: "jwt-a" };
const bob: ConnectSession = { uid: "2", token: "im", wsAddr: "ws://im", jwt: "jwt-b" };

function stubFetch(reply: (uids: number[]) => [number, unknown]) {
  const calls: number[][] = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    assert.match(String(input), /\/api\/v1\/addons\/auth\/directory\/resolve$/);
    assert.equal(init.method, "POST");
    const { uids } = JSON.parse(String(init.body)) as { uids: number[] };
    calls.push(uids);
    const [status, body] = reply(uids);
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; resetNames(); } };
}

const ok = (items: unknown[], degraded = false) => [200, { code: 0, message: "success", data: { items, degraded } }] as [number, unknown];
const profile = (nickName: string, accountType = "human") => ({ nickName, avatar: "", accountType, provisioned: true });

// The user ruling (UNI-IMUX2): a person who never touched IM still shows their
// nickName; the client never falls back to the UID.
test("one batched call names every visible uid; the UID is never the answer", async () => {
  const f = stubFetch(() => ok([
    { uid: 7, profile: profile("赖碧威") },
    { uid: 8, profile: profile("helper", "agent") },
    { uid: 9, profile: null },
  ]));
  try {
    assert.equal(nameFor("7"), "", "unresolved = empty (skeleton), not the uid");
    await ensureNames(["7", "8", "9", "7", "abc", "0", ""], alice);
    assert.deepEqual(f.calls, [[7, 8, 9]], "deduped, non-numeric and 0 dropped, one call");
    assert.equal(nameFor("7", "Portal user 7"), "赖碧威");
    assert.equal(accountTypeOf("8"), "agent");
    assert.ok(isMissing("9") && !isMissing("7"));
    await ensureNames(["7", "8", "9"], alice);
    assert.equal(f.calls.length, 1, "cached: no refetch storm");
  } finally { f.restore(); }
});

test("before resolution only a real stored name is used; placeholders never render", () => {
  assert.equal(nameFor("5", "Portal user 5", "portal_9f1c", "陈默"), "陈默");
  assert.equal(nameFor("5", "Portal user 5", "portal_9f1c"), "");
  assert.ok(!isRealName("Portal user 12") && !isRealName("portal_ab") && !isRealName("  "));
  assert.ok(isRealName("Portal user Chen"));
});

test("failures stay a skeleton and retry; the directory switched off does not", async () => {
  let fail = true;
  const f = stubFetch((uids) => fail
    ? [500, { code: 500, message: "directory resolve failed" }]
    : ok(uids.map((uid) => ({ uid, profile: profile(`N${uid}`) }))));
  try {
    await ensureNames(["3"], alice); // never throws
    assert.equal(nameFor("3"), "");
    fail = false;
    await ensureNames(["3"], alice); // not cached as failed-forever: a later ask retries
    assert.equal(nameFor("3"), "N3");
  } finally { f.restore(); }
  const off = stubFetch(() => [404, { code: 404, message: "directory is disabled" }]);
  try {
    await ensureNames(["4"], alice);
    assert.equal(nameFor("4", "Stored Four"), "Stored Four");
  } finally { off.restore(); }
});

test("a degraded placeholder is not cached as the name", async () => {
  let degraded = true;
  const f = stubFetch((uids) => ok(uids.map((uid) => ({
    uid, profile: profile(degraded ? `Portal user ${uid}` : "Real Name") })), degraded));
  try {
    await ensureNames(["6"], alice);
    assert.equal(nameFor("6"), "");
    degraded = false;
    await ensureNames(["6"], alice);
    assert.equal(nameFor("6"), "Real Name");
  } finally { f.restore(); }
});

test("an account switch drops the previous account's names", async () => {
  const f = stubFetch((uids) => ok(uids.map((uid) => ({ uid, profile: profile(`A${uid}`) }))));
  try {
    await ensureNames(["7"], alice);
    assert.equal(nameFor("7"), "A7");
    await ensureNames([], bob);
    assert.equal(nameFor("7"), "", "bob's session starts clean");
  } finally { f.restore(); }
});

// UNI-IM-AVATARS: resolve's avatar wins; a stored one (e.g. a group member row) is the fallback.
test("avatarFor: resolved avatar wins, else the stored one, else empty (initials)", async () => {
  const f = stubFetch(() => ok([
    { uid: 20, profile: { ...profile("碧"), avatar: "https://cdn.example/20.png" } },
    { uid: 21, profile: { ...profile("空"), avatar: "" } },
  ]));
  try {
    assert.equal(avatarFor("20", "https://stored/20.png"), "https://stored/20.png", "unresolved: the stored one");
    await ensureNames(["20", "21"], alice);
    assert.equal(avatarFor("20", "https://stored/20.png"), "https://cdn.example/20.png", "resolved wins");
    assert.equal(avatarFor("21", "https://stored/21.png"), "https://stored/21.png", "resolved empty: stored fallback");
    assert.equal(avatarFor("21"), "", "no avatar anywhere: empty = initials");
  } finally { f.restore(); }
});

// UNI-IMUX4: resolve returns username + enterprise; the handle is never portal_*.
test("handle and enterprise come from resolve; a null username beats a stale stored one", async () => {
  const f = stubFetch(() => ok([
    { uid: 11, profile: { ...profile("碧"), username: "bi.w", enterprise: true } },
    { uid: 12, profile: { ...profile("Kim"), username: null, enterprise: false } },
    { uid: 13, profile: profile("Old auth") }, // pre-IMUX4 auth: fields absent
  ]));
  try {
    assert.equal(handleFor("11", "portal_x"), "", "unresolved: a portal_* stored name is no handle");
    assert.equal(handleFor("11", "stored"), "stored", "unresolved: a real stored username is");
    assert.equal(isEnterprise("11"), undefined);
    await ensureNames(["11", "12", "13"], alice);
    assert.equal(handleFor("11"), "bi.w");
    assert.equal(isEnterprise("11"), true);
    assert.equal(handleFor("12", "old.name"), "", "resolved null wins over the row");
    assert.equal(isEnterprise("12"), false);
    assert.equal(handleFor("13", "row.name"), "row.name", "older auth: falls back to the row");
    assert.equal(isEnterprise("13"), undefined);
  } finally { f.restore(); }
});

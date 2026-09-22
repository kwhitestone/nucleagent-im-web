import assert from "node:assert/strict";
import test from "node:test";
import {
  clearCachedContacts,
  contactsFromMembers,
  isDialableUid,
  loadCachedContacts,
  mergeContacts,
  resolveContactName,
  saveCachedContacts,
} from "../src/contacts.ts";
import type { Contact, GroupMember } from "../src/api.ts";

const alice: Contact = { id: 5, username: "imtest920001", displayName: "IM Test 920001", accountType: "human" };
const bot: Contact = { id: 7, username: "helper", displayName: "", accountType: "agent" };

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

// P1 fallback chain: known name -> hydrated name -> raw UID.
test("a known contact resolves to its display name, falling back to username", () => {
  assert.equal(resolveContactName([alice], "5"), "IM Test 920001");
  // Empty displayName must fall through to username, not render as blank.
  assert.equal(resolveContactName([bot], "7"), "helper");
});

test("an unknown uid resolves to undefined so the caller can show the raw UID", () => {
  assert.equal(resolveContactName([alice], "999"), undefined);
  assert.equal(resolveContactName([], "5"), undefined);
});

test("group members hydrate names for uids that were never searched", () => {
  const members: GroupMember[] = [
    { uid: 12, username: "carol", displayName: "Carol", avatar: "", accountType: "human" },
  ];
  // Before hydrate the uid is unresolvable; after, it has a name.
  assert.equal(resolveContactName([], "12"), undefined);
  assert.equal(resolveContactName(contactsFromMembers(members), "12"), "Carol");
});

test("merging keeps one entry per uid and prefers the newest name", () => {
  const renamed: Contact = { ...alice, displayName: "Renamed" };
  const merged = mergeContacts([alice, bot], [renamed]);
  assert.equal(merged.filter((item) => item.id === 5).length, 1);
  assert.equal(resolveContactName(merged, "5"), "Renamed");
  // An existing unrelated contact is retained.
  assert.equal(resolveContactName(merged, "7"), "helper");
});

// The P1 repro: a name seen before a reload must still resolve after one.
test("cached contacts survive a reload and clear on sign-out", () => {
  withStorage(() => {
    saveCachedContacts("2", [alice]);
    const afterReload = loadCachedContacts("2");
    assert.equal(resolveContactName(afterReload, "5"), "IM Test 920001");

    clearCachedContacts("2");
    assert.deepEqual(loadCachedContacts("2"), []);
  });
});

// The cache is per-account: the shell can swap users by pushing a new token with no
// sign-out in between, and one user's names must never render in another's session.
test("one account's cached names are invisible to another account", () => {
  withStorage(() => {
    saveCachedContacts("2", [alice]);
    assert.deepEqual(loadCachedContacts("3"), []);
    assert.equal(resolveContactName(loadCachedContacts("3"), "5"), undefined);

    // Signing the second account out must not destroy the first account's cache.
    clearCachedContacts("3");
    assert.equal(resolveContactName(loadCachedContacts("2"), "5"), "IM Test 920001");
  });
});

test("a corrupt or absent cache degrades to empty rather than throwing", () => {
  withStorage(() => {
    globalThis.localStorage.setItem("im-web.contacts.2", "{not json");
    assert.deepEqual(loadCachedContacts("2"), []);
    globalThis.localStorage.setItem("im-web.contacts.2", JSON.stringify([{ nope: true }, alice]));
    assert.deepEqual(loadCachedContacts("2"), [alice]);
  });
  // No storage at all (private mode / blocked) must not throw either.
  assert.deepEqual(loadCachedContacts("2"), []);
  assert.doesNotThrow(() => saveCachedContacts("2", [alice]));
});

// P2: only numeric UIDs address a WuKongIM person channel.
test("only a numeric uid is dialable", () => {
  assert.equal(isDialableUid("5"), true);
  assert.equal(isDialableUid("  920001  "), true);
  assert.equal(isDialableUid(""), false);
  assert.equal(isDialableUid("abc"), false);
  assert.equal(isDialableUid("5a"), false);
  assert.equal(isDialableUid("-5"), false);
});

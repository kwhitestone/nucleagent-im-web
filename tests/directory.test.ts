import assert from "node:assert/strict";
import test from "node:test";
import { provisionAddress, provisionContact, searchDirectory, type ConnectSession } from "../src/api.ts";

const session: ConnectSession = { uid: "1", token: "im", wsAddr: "ws://im", jwt: "jwt" };

function stubFetch(responses: Array<[number, unknown]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    const [status, body] = responses[calls.length - 1];
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
  return { calls, restore: () => { globalThis.fetch = original; } };
}

test("directory search returns merged entries with paging", async () => {
  const page = { items: [{ id: 0, portalUid: 7, username: "", displayName: "Ann", accountType: "human", provisioned: false }], page: 2, hasMore: true, degraded: false };
  const f = stubFetch([[200, { code: 0, message: "success", data: page }]]);
  try {
    assert.deepEqual(await searchDirectory(" an ", session, 2), page);
  } finally { f.restore(); }
  assert.match(f.calls[0].url, /\/api\/v1\/addons\/auth\/directory\/search\?q=an&page=2$/);
  assert.equal((f.calls[0].init.headers as Record<string, string>).Authorization, "jwt");
});

test("kill-switch off (404) falls back to contacts search, provisioned only", async () => {
  const f = stubFetch([
    [404, { code: 404, message: "directory is disabled" }],
    [200, { code: 0, message: "success", data: [{ id: 5, username: "bob", displayName: "Bob", accountType: "human" }] }],
  ]);
  let page;
  try { page = await searchDirectory("bo", session); } finally { f.restore(); }
  assert.match(f.calls[1].url, /\/contacts\/search\?q=bo&limit=20$/);
  assert.deepEqual(page, { items: [{ id: 5, username: "bob", displayName: "Bob", accountType: "human", provisioned: true }], page: 1, hasMore: false, degraded: true });
});

test("directory errors other than 404 surface instead of silently falling back", async () => {
  const f = stubFetch([[500, { code: 500, message: "directory search failed" }]]);
  try { await assert.rejects(searchDirectory("bo", session), /directory search failed/); } finally { f.restore(); }
});

test("picking a portal-only user provisions once; provisioned users skip the call", async () => {
  const f = stubFetch([[200, { code: 0, message: "success", data: { id: 42 } }]]);
  try {
    const contact = await provisionContact({ id: 0, portalUid: 7, username: "", displayName: "Ann", accountType: "human", provisioned: false }, session);
    assert.deepEqual(contact, { id: 42, username: "", displayName: "Ann", accountType: "human" });
    const known = { id: 5, username: "bob", displayName: "Bob", accountType: "human" as const, provisioned: true };
    assert.equal(await provisionContact(known, session), known);
  } finally { f.restore(); }
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.method, "POST");
  assert.match(f.calls[0].url, /\/api\/v1\/addons\/auth\/directory\/provision$/);
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { portalUid: 7 });
});

// UNI-OID: search -> DM addresses by openId; portalUid only for an entry without one.
test("picking a not-yet-joined person provisions by openId, in the POST body only", async () => {
  const f = stubFetch([
    [200, { code: 0, message: "success", data: { id: 42 } }],
    [200, { code: 0, message: "success", data: { id: 43 } }],
    [404, { code: 404, message: "user not available" }],
  ]);
  try {
    const contact = await provisionContact({ id: 0, openId: "nduc_sms_x1", portalUid: 7, username: "", displayName: "Ann", accountType: "human", provisioned: false }, session);
    assert.equal(contact.id, 42);
    await provisionContact({ id: 0, openId: null, portalUid: 8, username: "", displayName: "Old", accountType: "human", provisioned: false }, session);
    await assert.rejects(provisionAddress({ openId: "nduc_nd_unknown" }, session), /user not available/);
  } finally { f.restore(); }
  assert.deepEqual(f.calls.map((c) => JSON.parse(String(c.init.body))),
    [{ openId: "nduc_sms_x1" }, { portalUid: 8 }, { openId: "nduc_nd_unknown" }], "openId wins; legacy portalUid only without one");
  assert.ok(f.calls.every((c) => /\/directory\/provision$/.test(c.url) && c.init.method === "POST"), "never in a URL");
});

// --- browse (empty query) ------------------------------------------------------

import { browseDirectory, type DirectoryEntry } from "../src/api.ts";
import { loadComponent, render } from "./render.ts";

const person = (i: number, provisioned: boolean): DirectoryEntry => provisioned
  ? { id: i, username: `u${i}`, displayName: `P${String(i).padStart(2, "0")}`, accountType: "human", provisioned }
  : { id: 0, portalUid: i, username: "", displayName: `P${String(i).padStart(2, "0")}`, accountType: "human", provisioned };

test("browse pages a synthetic directory to the end by following nextCursor", async () => {
  const everyone = Array.from({ length: 47 }, (_, i) => person(i + 1, i % 2 === 0));
  const pages = [everyone.slice(0, 20), everyone.slice(20, 40), everyone.slice(40)];
  const f = stubFetch(pages.map((items, i) => [200, { code: 0, message: "success",
    data: { items, page: 1, hasMore: i < 2, degraded: false, nextCursor: i < 2 ? `c${i + 1}` : undefined } }]));
  const seen: DirectoryEntry[] = [];
  try {
    let cursor = "";
    for (;;) {
      const page = await browseDirectory(session, cursor);
      assert.ok(page);
      seen.push(...page.items);
      if (!page.hasMore) break;
      cursor = page.nextCursor!;
    }
  } finally { f.restore(); }
  assert.deepEqual(seen, everyone);
  assert.match(f.calls[0].url, /\/directory\/search\?pageSize=20$/, "empty q = list mode, no q param");
  assert.match(f.calls[1].url, /\/directory\/search\?pageSize=20&cursor=c1$/);
  assert.match(f.calls[2].url, /cursor=c2$/);
});

test("browse returns null when the directory is off, and surfaces other errors", async () => {
  let f = stubFetch([[404, { code: 404, message: "directory is disabled" }]]);
  try { assert.equal(await browseDirectory(session), null); } finally { f.restore(); }
  f = stubFetch([[400, { code: 400, message: "invalid directory cursor" }]]);
  try { await assert.rejects(browseDirectory(session, "x"), /invalid directory cursor/); } finally { f.restore(); }
});

const ContactPicker = await loadComponent("src/components/ContactPicker.vue");

// SSR emits the closed picker only; seed browse state through setup's bindings.
async function renderPicker(state: Record<string, unknown>, props: Record<string, unknown> = {}): Promise<string> {
  const target = ContactPicker as { setup: (p: unknown, c: unknown) => Record<string, { value: unknown }> };
  const original = target.setup;
  target.setup = function patched(this: unknown, p: unknown, c: unknown) {
    const b = original.call(this, p, c);
    for (const [k, v] of Object.entries(state)) b[k].value = v;
    return b;
  };
  try { return await render(ContactPicker, { session, ...props }); } finally { target.setup = original; }
}

test("browse list renders both badges and 加载更多 while more pages remain", async () => {
  const html = await renderPicker({ open: true, browseLoaded: true, browseHasMore: true,
    browseItems: [person(5, true), person(9, false)] });
  assert.match(html, /data-testid="im-directory-browse"/);
  assert.match(html, /P05[\s\S]*@u5 · UID 5/, "joined: username + uid");
  assert.match(html, /P09[\s\S]*企业账号 · 尚未加入/, "portal-only: enterprise + not-joined");
  assert.match(html, /account-badge portal/);
  assert.match(html, /加载更多/);
  assert.doesNotMatch(html, /已显示全部/);
});

test("browse shows the end-of-list marker, and an empty state for an empty directory", async () => {
  const end = await renderPicker({ open: true, browseLoaded: true, browseItems: [person(1, true)] });
  assert.match(end, /已显示全部/);
  assert.doesNotMatch(end, /加载更多/);
  const empty = await renderPicker({ open: true, browseLoaded: true, browseItems: [] });
  assert.match(empty, /目录里还没有其他人/);
});

test("browse hides already-picked and excluded people, and flags a degraded directory", async () => {
  const html = await renderPicker({ open: true, browseLoaded: true, browseDegraded: true,
    browseItems: [person(1, true), person(2, true), person(3, false)] },
  { excludeUids: [1], modelValue: [{ id: 2, username: "u2", displayName: "P02", accountType: "human" }] });
  const list = html.slice(html.indexOf("im-directory-browse"));
  assert.doesNotMatch(list, /P01|UID 2\b/);
  assert.match(list, /P03/);
  assert.match(html, /目录暂不可用/);
});

test("typing leaves browse for search; directory off keeps the picker search-only", async () => {
  const typed = await renderPicker({ open: true, browseLoaded: true, browseItems: [person(1, true)], query: "zh" });
  assert.doesNotMatch(typed, /im-directory-browse/);
  const off = await renderPicker({ open: true, browseOff: true });
  assert.doesNotMatch(off, /im-directory-browse/);
  const closed = await renderPicker({ browseLoaded: true, browseItems: [person(1, true)] });
  assert.doesNotMatch(closed, /im-directory-browse/, "closed until the box is focused");
});

test("picker sub-line reads the resolved @username, else 企业账号, then the UID (IMUX4)", async () => {
  const { ensureNames, resetNames } = await import("../src/names.ts");
  const f = stubFetch([[200, { code: 0, message: "success", data: { degraded: false, items: [
    { uid: 5, profile: { nickName: "P05", avatar: "", accountType: "human", provisioned: true, username: "real.five", enterprise: true } },
    { uid: 6, profile: { nickName: "P06", avatar: "", accountType: "human", provisioned: true, username: null, enterprise: true } },
  ] } }]]);
  try {
    await ensureNames(["5", "6"], session);
    const row6 = { ...person(6, true), username: "portal_66" };
    const html = await renderPicker({ open: true, browseLoaded: true, browseItems: [person(5, true), row6] });
    assert.match(html, /P05[\s\S]*@real\.five · UID 5/, "resolved handle beats the row's u5");
    assert.match(html, /P06[\s\S]*企业账号 · UID 6/, "no real handle: Enterprise");
    assert.doesNotMatch(html, /portal_66/);
  } finally { f.restore(); resetNames(); }
});

// --- UNI-PHONESEARCH ------------------------------------------------------------

import { phoneDigits } from "../src/api.ts";

test("phone-like input is sent as phone digits as well as q (spaces, dashes, +86 stripped)", async () => {
  assert.equal(phoneDigits("138 1234-5678"), "13812345678");
  assert.equal(phoneDigits("+86 5678"), "5678");
  for (const notPhone of ["138", "ann", "13a8", "138****5678", ""]) assert.equal(phoneDigits(notPhone), "", notPhone);
  const page = { items: [], page: 1, hasMore: false, degraded: false };
  const ok: [number, unknown] = [200, { code: 0, message: "success", data: page }];
  const f = stubFetch([ok, ok, ok, ok]);
  try {
    await searchDirectory("+86 138-1234", session, 2);
    await searchDirectory("an", session);
    await searchDirectory("13", session); // a number too short to be a phone: still not in a URL
    await searchDirectory("ann 5678", session); // a digit run inside text
  } finally { f.restore(); }
  // UNI-PHONESEARCH-2: the phone travels in a POST body, never in the URL.
  assert.equal(f.calls[0].init.method, "POST");
  assert.match(f.calls[0].url, /\/api\/v1\/addons\/auth\/directory\/search$/);
  assert.equal((f.calls[0].init.headers as Record<string, string>)["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(String(f.calls[0].init.body)), { q: "+86 138-1234", phone: "1381234", page: 2 }, "q still goes: a name may be digits too");
  assert.equal(f.calls[1].init.method, undefined, "names stay on GET");
  assert.match(f.calls[1].url, /\?q=an&page=1$/);
  assert.deepEqual(JSON.parse(String(f.calls[2].init.body)), { q: "13", page: 1 }, "no phone under 4 digits");
  assert.deepEqual(JSON.parse(String(f.calls[3].init.body)), { q: "ann 5678", page: 1 });
  for (const c of f.calls) {
    const u = new URL(c.url);
    const where = decodeURIComponent(u.pathname + u.search);
    for (const typed of ["138", "1234", "13", "5678"]) assert.ok(!where.includes(typed), `"${typed}" in ${c.url}`);
  }
});

test("directory off (404) on a phone search: no GET fallback that would put the number in a URL", async () => {
  const f = stubFetch([[404, { code: 404, message: "directory is disabled" }]]);
  let page;
  try { page = await searchDirectory("138 1234", session); } finally { f.restore(); }
  assert.equal(f.calls.length, 1, "contacts/search (GET) is not called with a number");
  assert.deepEqual(page, { items: [], page: 1, hasMore: false, degraded: true });
});

test("search by a phone fragment renders hits with the masked phone; no raw number in the DOM", async () => {
  const hits: DirectoryEntry[] = [
    { ...person(0, false), portalUid: 21, displayName: "陈雨桐", phoneMasked: "138****5678" },
    { ...person(7, true), displayName: "林雨", phoneMasked: "139****4321" },
    { ...person(0, false), portalUid: 22, displayName: "无号码", phoneMasked: null },
  ];
  const html = await renderPicker({ query: "5678", results: hits });
  assert.match(html, /陈雨桐[\s\S]*企业账号 · 138\*\*\*\*5678 · 尚未加入/);
  assert.match(html, /林雨[\s\S]*UID 7 · 139\*\*\*\*4321/);
  assert.match(html, /无号码[\s\S]*<small>企业账号 · 尚未加入/, "no phone: nothing in between");
  assert.doesNotMatch(html, /\d{11}/, "never a full number");
  assert.match(html, /inputmode="tel"/, "digits typed: phone keypad");
  const name = await renderPicker({ query: "an" });
  assert.match(name, /inputmode="search"/);
  const none = await renderPicker({ query: "5678", results: [] });
  assert.match(none, /部分号码在来源处已隐藏中间位/, "a phone search that misses explains the masked-at-source gap");
});

test("the rail's self card gets the masked phone from resolve", async () => {
  const { ensureNames, phoneMaskedOf, resetNames } = await import("../src/names.ts");
  const f = stubFetch([[200, { code: 0, message: "success", data: { degraded: false, items: [
    { uid: 1, profile: { nickName: "Me", avatar: "", accountType: "human", provisioned: true, phoneMasked: "138****5678" } },
    { uid: 2, profile: { nickName: "Ops", avatar: "", accountType: "human", provisioned: true, phoneMasked: null } },
  ] } }]]);
  try {
    await ensureNames(["1", "2"], session);
    assert.deepEqual([phoneMaskedOf("1"), phoneMaskedOf("2"), phoneMaskedOf("3")], ["138****5678", null, undefined]);
  } finally { f.restore(); resetNames(); }
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync("src/components/IdentityCard.vue", "utf8"), /phoneMasked: phoneMaskedOf\(props\.uid\)/);
});

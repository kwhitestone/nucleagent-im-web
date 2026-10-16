// IM-SEARCH-CLICK-CARD-1620: on the search page, choosing a person (click, or Enter
// on the highlighted row) opens that person's shared profile card — never the chat.
// Only the card's explicit "Send message" opens the conversation. Closing the card
// leaves the query, results, category and highlighted row as they were.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { Channel, ChannelTypePerson, Conversation } from "wukongimjssdk";
import { loadComponent, render } from "./render.ts";
import { profileActions } from "../src/accountPopover.ts";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";

const session = { uid: "11", token: "t", wsAddr: "ws://im", jwt: "jwt" };
const storage = new Map<string, string>();
globalThis.localStorage ??= {
  getItem: (k: string) => storage.get(k) ?? null,
  setItem: (k: string, v: string) => { storage.set(k, String(v)); },
  removeItem: (k: string) => { storage.delete(k); },
  clear: () => storage.clear(),
  key: () => null,
  length: 0,
} as Storage;

type Bindings = Record<string, any>;
async function mount(props: Record<string, unknown>, seed: (b: Bindings) => void) {
  const component = await loadComponent("src/components/SearchPanel.vue") as { setup: (p: unknown, c: any) => Bindings };
  const emitted: unknown[][] = [];
  const original = component.setup;
  let bindings: Bindings = {};
  component.setup = function (this: unknown, p: unknown, ctx: any) {
    bindings = original.call(this, p, { ...ctx, emit: (...args: unknown[]) => emitted.push(args) });
    seed(bindings);
    return bindings;
  };
  try {
    const html = await render(component, props);
    return { html, bindings, emitted };
  } finally {
    component.setup = original;
  }
}

const lin = { id: 14, portalUid: 3, username: "lin.yu", displayName: "林雨", accountType: "human", provisioned: true, openId: "nduc_nd_14" };
const linSms = { id: 15, portalUid: 103, username: "", displayName: "林雨", accountType: "human", provisioned: true, phoneMasked: "138****0001", openId: "nduc_sms_15" };
const fresh = { id: 0, username: "", displayName: "林雨", accountType: "human", provisioned: false, openId: "nduc_nd_new" };
const panelProps = { session, conversations: [], hiddenKeys: new Set(), agents: [], titleFor: () => "" };
const seeded = (people: unknown[]) => (b: Bindings) => {
  b.query.value = "林雨";
  b.loading.value = false;
  b.people.value = people;
};
const rowEl = { id: "row" };
const named = (emitted: unknown[][], name: string) => emitted.filter((e) => e[0] === name);

test("clicking a person's row opens their card for that very account, never the chat", async () => {
  const { bindings, emitted } = await mount(panelProps, seeded([lin, linSms]));
  const [first, second] = bindings.flat.value;
  bindings.pick(first, rowEl);
  bindings.pick(second, rowEl);
  assert.equal(named(emitted, "contact").length, 0, "no conversation is opened by the row");
  const cards = named(emitted, "profile") as Array<[string, unknown, any]>;
  assert.deepEqual(cards.map((c) => [c[2].uid, c[2].openId]), [["14", "nduc_nd_14"], ["15", "nduc_sms_15"]]);
  assert.equal(cards[0][1], rowEl, "the card is anchored on the clicked row");
  assert.equal(cards[0][2].select, undefined, "no 'Select' primary: the card offers Send message instead");
});

test("the card's explicit Send message is what opens the chat (and only for that person)", async () => {
  const { bindings, emitted } = await mount(panelProps, seeded([lin, fresh]));
  bindings.pick(bindings.flat.value[1], rowEl);
  const [, , target] = named(emitted, "profile")[0] as [string, unknown, any];
  assert.equal(typeof target.message, "function");
  assert.equal(named(emitted, "contact").length, 0);
  target.message();
  assert.deepEqual(named(emitted, "contact").map((e) => e[1]), [fresh], "the not-yet-joined entry goes to searchContact (provisioning) as before");
});

test("closing the card keeps query, results, category and the highlighted row", async () => {
  const { bindings } = await mount(panelProps, seeded([lin, linSms]));
  bindings.tab.value = "contacts";
  bindings.active.value = 1;
  bindings.pick(bindings.flat.value[1], rowEl);
  assert.deepEqual(
    [bindings.query.value, bindings.people.value.length, bindings.tab.value, bindings.active.value],
    ["林雨", 2, "contacts", 1],
  );
});

test("keyboard: Enter on the highlighted person opens the card, not the chat", async () => {
  const doc = globalThis.document;
  globalThis.document = { querySelector: () => rowEl } as unknown as Document;
  try {
    const { bindings, emitted } = await mount(panelProps, seeded([lin]));
    let prevented = false;
    bindings.onKeydown({ key: "Enter", preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(named(emitted, "contact").length, 0);
    assert.equal(named(emitted, "profile").length, 1);
    assert.equal(named(emitted, "profile")[0][1], rowEl);
  } finally {
    globalThis.document = doc;
  }
});

test("keyboard: Tab is not captured, so focus can reach each result row (one focus stop per person)", async () => {
  const { html, bindings } = await mount(panelProps, seeded([lin, linSms]));
  for (const shiftKey of [false, true]) {
    let prevented = false;
    bindings.onKeydown({ key: "Tab", shiftKey, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(bindings.tab.value, "all");
  }
  assert.equal(html.match(/data-testid="im-search-row-contact"/g)?.length, 2);
  assert.equal(html.match(/<button[^>]*data-testid="im-search-row-contact"[^>]*aria-haspopup="dialog"|<button[^>]*aria-haspopup="dialog"[^>]*data-testid="im-search-row-contact"/g)?.length, 2,
    "native button rows announce that they open a dialog");
  assert.doesNotMatch(html, /data-testid="im-search-info"/, "no second, duplicate card button per row");
});

test("after a 429 the people still shown open their card, and the hint stays", async () => {
  const { html, bindings, emitted } = await mount(panelProps, (b) => { seeded([lin])(b); b.rateLimited.value = true; });
  assert.match(html, /data-testid="im-search-rate-limited"/);
  bindings.pick(bindings.flat.value[0], rowEl);
  assert.equal(named(emitted, "profile").length, 1);
  assert.equal(named(emitted, "contact").length, 0);
  assert.equal(bindings.rateLimited.value, true);
});

test("non-person rows keep their own action (a conversation row still opens it)", async () => {
  const conversation = new Conversation();
  conversation.channel = new Channel("14", ChannelTypePerson);
  const { bindings, emitted } = await mount({ ...panelProps, conversations: [conversation], titleFor: () => "林雨" }, seeded([]));
  const row = bindings.flat.value.find((r: { kind: string }) => r.kind === "conversation");
  bindings.pick(row, rowEl);
  assert.deepEqual(named(emitted, "conversation").map((e) => e[1]), [conversation]);
  assert.equal(named(emitted, "profile").length, 0);
});

test("App: the card's Send message from search runs the search's own open (provision + close search); a card that cannot open says so", () => {
  const app = readFileSync("src/App.vue", "utf8");
  assert.match(app, /<SearchPanel[\s\S]*?@contact="searchContact"[\s\S]*?@profile="openProfile"/);
  assert.match(app, /onMessage: can\.message \? \(\) => void \(target\.message \?\? message\)\(\) : undefined/);
  assert.match(app, /\.then\(\(shown\) => \{ if \(!shown && session\.value === opener\) loginError\.value = t\("profile\.unavailable"\); \}\)/);
  assert.ok(zh.profile.unavailable && en.profile.unavailable);
});

test("card actions from search: others get Send message (legacy portal-only too); yourself gets none, so no self-DM", () => {
  const message = () => {};
  const self = { selfUid: "11" };
  assert.deepEqual(profileActions({ uid: "14", message }, self), { select: false, message: true, addToGroup: true });
  assert.deepEqual(profileActions({ uid: "", openId: "nduc_nd_new", message }, self), { select: false, message: true, addToGroup: false });
  assert.deepEqual(profileActions({ uid: "", message }, self), { select: false, message: true, addToGroup: false }, "portalUid-only hit");
  assert.deepEqual(profileActions({ uid: "11", message }, self), { select: false, message: false, addToGroup: false }, "own row");
  assert.deepEqual(profileActions({ uid: "" }, self), { select: false, message: false, addToGroup: false }, "no address, no caller open");
});

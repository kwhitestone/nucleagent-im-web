// IM-SEARCH-PROFILE-INTERACTION: a person found by search (search page, contact
// picker, group dialog's picker) opens the shared profile card from their
// avatar/name or a visible "View profile" button — never the chat or a pick by
// accident; the row itself still messages/picks. The card is the shell's
// account-ui module; nothing here renders a second card.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadComponent, render } from "./render.ts";
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
async function mount(path: string, props: Record<string, unknown>, seed: (b: Bindings) => void, locale: "zh" | "en" = "zh") {
  const component = await loadComponent(path) as { setup: (p: unknown, c: any) => Bindings };
  const emitted: unknown[][] = [];
  const original = component.setup;
  let bindings: Bindings = {};
  component.setup = function (this: unknown, p: unknown, ctx: any) {
    bindings = original.call(this, p, { ...ctx, emit: (...args: unknown[]) => emitted.push(args) });
    seed(bindings);
    return bindings;
  };
  try {
    const html = await render(component, props, locale);
    return { html, bindings, emitted };
  } finally {
    component.setup = original;
  }
}

/** A click whose target is (inside) a [data-profile] element, or not. */
function click(onProfile: boolean, row = { id: "row" }) {
  return { target: { closest: (sel: string) => (onProfile && sel === "[data-profile]" ? {} : null) }, currentTarget: row };
}

const lin = { id: 14, portalUid: 3, username: "lin.yu", displayName: "林雨", accountType: "human", provisioned: true, openId: "nduc_nd_14" };
const linSms = { id: 15, portalUid: 103, username: "", displayName: "林雨", accountType: "human", provisioned: true, phoneMasked: "138****0001", openId: "nduc_sms_15" };
const panelProps = { session, conversations: [], hiddenKeys: new Set(), agents: [], titleFor: () => "" };

test("search keyboard: Tab and Shift+Tab keep native focus traversal and category", async () => {
  const { bindings } = await mount("src/components/SearchPanel.vue", panelProps, () => {});
  for (const shiftKey of [false, true]) {
    let prevented = false;
    bindings.onKeydown({ key: "Tab", shiftKey, preventDefault: () => { prevented = true; } });
    assert.equal(prevented, false);
    assert.equal(bindings.tab.value, "all");
  }
});

test("search exit: every false transition closes the shared card synchronously", () => {
  const app = readFileSync("src/App.vue", "utf8");
  assert.match(app, /watch\(searchOpen, \(open\) => \{\s*if \(!open\) accountUi\.close\(\);\s*\}, \{ flush: "sync" \}\)/);
});

for (const locale of ["zh", "en"] as const) {
  test(`${locale}: search page contact row — avatar and name are card targets, a visible "View profile" button, the row still messages`, async () => {
    const { html, bindings, emitted } = await mount("src/components/SearchPanel.vue", panelProps, (b) => {
      b.query.value = "林雨";
      b.loading.value = false;
      b.people.value = [lin, linSms];
    }, locale);
    const copy = locale === "zh" ? zh.profile : en.profile;
    assert.ok(copy.viewShort, "profile.viewShort");
    assert.ok(html.includes(`>${copy.viewShort}<`), "visible text, not an icon-only ⓘ");
    assert.equal(html.match(/data-testid="im-search-info"/g)?.length, 2, "one button per person, not a second one");
    assert.ok(html.includes(`aria-label="${copy.viewOf.replace("{name}", "林雨")}"`), "label contains the visible text (WCAG 2.5.3)");
    assert.equal(html.match(/data-profile/g)?.length, 4, "avatar + name per row");
    assert.match(html, /UID 15 · 138\*\*\*\*0001/, "same-named accounts still told apart");

    const [first, second] = bindings.flat.value;
    bindings.onRowClick(first, click(true));
    bindings.onRowClick(second, click(true));
    assert.equal(emitted.filter((e) => e[0] === "contact").length, 0, "avatar/name never open the chat");
    const cards = emitted.filter((e) => e[0] === "profile") as Array<[string, unknown, any]>;
    assert.deepEqual(cards.map((c) => [c[2].uid, c[2].openId]), [["14", "nduc_nd_14"], ["15", "nduc_sms_15"]], "each row's own account, never guessed by name");
    assert.deepEqual([bindings.query.value, bindings.people.value.length], ["林雨", 2], "query and results untouched");

    bindings.onRowClick(first, click(false));
    assert.deepEqual(emitted.filter((e) => e[0] === "contact").map((e) => (e[1] as { id: number }).id), [14], "the rest of the row still messages");
  });
}

test("search page: after a 429 the kept people still open their card, and the hint stays", async () => {
  const { html, bindings, emitted } = await mount("src/components/SearchPanel.vue", panelProps, (b) => {
    b.query.value = "林雨";
    b.loading.value = false;
    b.rateLimited.value = true;
    b.people.value = [lin];
  });
  assert.match(html, /data-testid="im-search-rate-limited"/);
  bindings.onRowClick(bindings.flat.value[0], click(true));
  assert.equal(emitted.filter((e) => e[0] === "profile").length, 1);
  assert.equal(bindings.rateLimited.value, true);
});

test("search page: non-person rows ignore data-profile hits and keep their action", async () => {
  const src = readFileSync("src/components/SearchPanel.vue", "utf8");
  assert.match(src, /@click="onRowClick\(row, \$event\)"/);
  assert.match(src, /row\.kind === "contact" && [^\n]*closest\?\.\("\[data-profile\]"\)/);
});

test("picker: name is a card target, visible View profile in browse and search rows; a plain row click still picks", async () => {
  const { html, bindings, emitted } = await mount("src/components/ContactPicker.vue", { session, multiple: true }, (b) => {
    b.query.value = "林雨";
    b.results.value = [lin, linSms];
    b.page.value = 2;
    b.hasMore.value = true;
  });
  const src = readFileSync("src/components/ContactPicker.vue", "utf8");
  assert.equal(src.match(/data-testid="im-picker-info"/g)?.length, 2);
  assert.equal(src.match(/t\('profile\.viewShort'\)/g)?.length, 2, "browse and search rows alike");
  assert.ok(html.includes(`>${zh.profile.viewShort}<`));
  assert.equal(html.match(/data-profile/g)?.length, 2);

  const [row] = bindings.peopleResults.value;
  await bindings.onPick(row, click(true));
  assert.equal(emitted.filter((e) => e[0] === "update:modelValue" || e[0] === "select").length, 0, "the name never selects");
  assert.equal(emitted.filter((e) => e[0] === "profile").length, 1);
  assert.deepEqual([bindings.query.value, bindings.results.value.length, bindings.page.value, bindings.hasMore.value], ["林雨", 2, 2, true],
    "query, results and paging kept for when the card closes");

  await bindings.onPick(row, click(false));
  assert.equal(emitted.filter((e) => e[0] === "update:modelValue").length, 1, "the row itself still picks");
});

test("picker: clicks inside the card (appended to body) do not collapse the open list under it", async () => {
  const { bindings } = await mount("src/components/ContactPicker.vue", { session }, () => {});
  bindings.root.value = { contains: () => false };
  bindings.open.value = true;
  bindings.closeOnOutside({ target: { closest: (sel: string) => (sel.includes(".acct-pop") ? {} : null) } });
  assert.equal(bindings.open.value, true, "card click keeps the list");
  bindings.closeOnOutside({ target: { closest: () => null } });
  assert.equal(bindings.open.value, false, "a real outside click still closes it");
});

test("app: a card that cannot open says so instead of doing nothing", () => {
  const app = readFileSync("src/App.vue", "utf8");
  assert.ok(zh.profile.unavailable && en.profile.unavailable);
  assert.match(app, /accountUi\.openProfile\(anchor, profileParams\([\s\S]*?\.then\(\(shown\) => \{ if \(!shown && session\.value === opener\) loginError\.value = t\("profile\.unavailable"\)/);
});

test("css: the View profile button is a 44px touch target that fits its label", () => {
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /\.contact-info \{[^}]*min-width: 44px;[^}]*height: 44px;/);
});

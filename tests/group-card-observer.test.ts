// IM-GROUP-TESTS-0442: the member-card area's ResizeObserver (N-G2a) through its whole life,
// adopted from review IM-GROUP-F1-REREVIEW-0356 Q7/Q8 plus the panel-close check it had to
// leave to the browser (Q9). The SSR renderer used elsewhere never registers onBeforeUnmount,
// so these tests mount for real: Vue's own createRenderer over a tiny in-memory node tree,
// the panel shown and dropped by a parent's v-if exactly as App.vue does. Rows are clicked
// through the template's own handler; the card is put into the panel's real card-area node.
// ResizeObserver is a fake that fires only observers still observing that node.
import assert from "node:assert/strict";
import test from "node:test";
import { createRenderer, defineComponent, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";
import { resetNames } from "../src/names.ts";
import { useAccountPopover } from "../src/accountPopover.ts";
import { loadComponent } from "./render.ts";

class El {
  children: El[] = [];
  parentNode: El | null = null;
  props: Record<string, any> = {};
  __v_skip = true; // like a DOM node, never wrapped by reactive(): identity is what the tests check
  tag: string;
  text: string;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  get childElementCount() { return this.children.filter((c) => !c.tag.startsWith("#")).length; }
  scrollIntoView(options: unknown) { scrolls.push([this, options]); }
  // A failing assert would otherwise print the whole tree through parentNode.
  [Symbol.for("nodejs.util.inspect.custom")]() { return `<${this.tag} ${this.props["data-testid"] ?? ""}>`; }
}
let scrolls: [El, unknown][] = [];
const detach = (n: El) => { const p = n.parentNode; if (p) { p.children.splice(p.children.indexOf(n), 1); n.parentNode = null; } };
const { createApp } = createRenderer<El, El>({
  createElement: (tag) => new El(tag),
  createText: (text) => new El("#text", text),
  createComment: (text) => new El("#comment", text),
  setText: (n, text) => { n.text = text; },
  setElementText: (n, text) => { n.children.forEach(detach); if (text) { const t = new El("#text", text); t.parentNode = n; n.children = [t]; } },
  insert: (child, parent, anchor) => {
    detach(child);
    const at = anchor ? parent.children.indexOf(anchor) : -1;
    parent.children.splice(at < 0 ? parent.children.length : at, 0, child);
    child.parentNode = parent;
  },
  remove: detach,
  parentNode: (n) => n.parentNode,
  nextSibling: (n) => n.parentNode?.children[n.parentNode.children.indexOf(n) + 1] ?? null,
  patchProp: (n, key, _prev, next) => { n.props[key] = next; },
});
const all = (n: El, testid: string): El[] =>
  [...(n.props["data-testid"] === testid ? [n] : []), ...n.children.flatMap((c) => all(c, testid))];

type Observer = { cb: () => void; targets: unknown[]; disconnected: boolean };
const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
const group = { id: 8, creatorUid: 1, title: "G", wukongChannelId: "group_8" };
const human = (uid: number) => ({ uid, username: `u${uid}`, displayName: `U${uid}`, avatar: "", accountType: "human" });
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

async function mount(memberCount = 50) {
  const saved = { RO: (globalThis as any).ResizeObserver, window: (globalThis as any).window, document: (globalThis as any).document, fetch: globalThis.fetch };
  const observers: Observer[] = [];
  (globalThis as any).ResizeObserver = class {
    o: Observer;
    constructor(cb: () => void) { this.o = { cb, targets: [], disconnected: false }; observers.push(this.o); }
    // A real ResizeObserver ignores observing the same node twice; so does this fake.
    observe(el: unknown) { if (!this.o.targets.includes(el)) this.o.targets.push(el); }
    unobserve(el: unknown) { this.o.targets = this.o.targets.filter((t) => t !== el); }
    disconnect() { this.o.disconnected = true; this.o.targets = []; }
  };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  (globalThis as any).document = { body: new El("body") };
  const members = Array.from({ length: memberCount }, (_, i) => human(i + 1));
  globalThis.fetch = (async (url: unknown) => new Response(JSON.stringify({
    code: 0,
    data: String(url).endsWith("/members") ? { group, members } : { items: [], degraded: false },
  }))) as typeof fetch;
  scrolls = [];
  const Dialog = await loadComponent("src/components/GroupDialog.vue");
  const open = ref(true);
  const hosts: unknown[] = [];
  // App.vue:2143 — `<GroupDialog v-if="groupDialogOpen" @profile="openProfile">`.
  const Parent = defineComponent(() => () => open.value
    ? h(Dialog as never, { session, group, onProfile: (_anchor: El, target: { host?: unknown }) => hosts.push(target.host) })
    : null);
  const root = new El("root");
  const app = createApp(Parent);
  app.use(createI18n({ legacy: false, locale: "zh", fallbackLocale: "zh", messages: { zh, en } as never }));
  app.mount(root);
  await tick();
  const host = () => all(root, "im-group-card-host")[0];
  const rows = () => all(root, "im-member-profile");
  return {
    observers, hosts, host,
    rows,
    /** Scrolls so far, as [row index, options] (identity of the row, compared cheaply). */
    scrolled: () => scrolls.map(([row, options]) => [rows().indexOf(row), options]),
    live: () => observers.filter((o) => !o.disconnected && o.targets.length),
    click(row: El) { row.props.onClick({ currentTarget: row }); },
    /** account-ui puts the card into the host (or takes it out); the area resizes. */
    card(shown: boolean) {
      const area = host();
      if (shown) { const c = new El("div"); c.parentNode = area; area.children.push(c); } else area.children.forEach(detach);
      this.resize();
    },
    resize() { for (const o of observers) if (!o.disconnected && o.targets.includes(host())) o.cb(); },
    async setOpen(value: boolean) { open.value = value; await nextTick(); if (value) await tick(); },
    async done() {
      app.unmount();
      Object.assign(globalThis, { ResizeObserver: saved.RO, window: saved.window, document: saved.document, fetch: saved.fetch });
      resetNames();
    },
  };
}

test("card observer: several opens keep one observer on the panel's card area, and it follows the latest row", async () => {
  const m = await mount();
  try {
    const rows = m.rows();
    assert.equal(rows.length, 50, "member rows are really rendered");
    m.click(rows[2]); m.click(rows[10]); m.click(rows[40]);
    assert.equal(m.observers.length, 1, "one observer for the panel, not one per open");
    assert.equal(m.observers[0].targets.length, 1);
    // ok(===), not equal(): a failing equal() ships the node tree to the runner, which chokes on it.
    assert.ok(m.observers[0].targets[0] === m.host(), "it watches the card area node");
    assert.ok(m.hosts.length === 3 && m.hosts.every((x) => x === m.host()), "every card is hosted in that area");
    m.card(true);
    assert.deepEqual(m.scrolled(), [[40, { block: "nearest" }]], "only the row that opened the current card, once");
  } finally { await m.done(); }
});

test("card observer: empty area never scrolls; a later card from a deep row brings that row back, on every resize", async () => {
  const m = await mount();
  try {
    const rows = m.rows();
    m.click(rows[2]); m.card(true);
    m.card(false); // card closed, area shrinks
    m.click(rows[40]); m.resize(); // card still loading
    m.card(true);
    m.resize(); // same card resizes again (e.g. avatar loaded)
    assert.deepEqual(m.scrolled(),
      [[2, { block: "nearest" }], [40, { block: "nearest" }], [40, { block: "nearest" }]]);
    assert.equal(m.live().length, 1, "still observing after the first card");
  } finally { await m.done(); }
});

test("card observer: closing the panel (v-if unmount) disconnects it; reopening starts one fresh observer", async () => {
  const m = await mount();
  // The panel shares the app-wide card layer (same module instance as the component's import).
  const popover = useAccountPopover();
  const close = popover.close;
  let closes = 0;
  popover.close = () => { closes++; };
  try {
    m.click(m.rows()[40]); m.card(true);
    const first = m.observers[0];
    assert.equal(closes, 0, "opening a card does not close the layer");
    await m.setOpen(false);
    assert.equal(m.rows().length, 0, "the panel is really gone");
    assert.equal(closes, 1, "the panel's member card is closed with the panel, once");
    assert.equal(first.disconnected, true, "the closed panel's observer is disconnected");
    assert.equal(m.live().length, 0, "nothing left observing");
    await m.setOpen(true);
    scrolls = [];
    m.click(m.rows()[30]); m.card(true);
    assert.equal(m.observers.length, 2);
    assert.equal(m.live().length, 1, "exactly one live observer after reopening");
    assert.deepEqual(m.scrolled(), [[30, { block: "nearest" }]], "the new panel follows its own row");
  } finally { popover.close = close; await m.done(); }
});

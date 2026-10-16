// IM-GROUP-COLDLOAD-FIX-0758 (N1 from review IM-GROUP-R5-REVIEW-0734): a card or popover asked
// for and then closed — or replaced by a newer one — before account-ui answers must never show
// up late. Nothing here replaces close(): the real createAccountPopover / useAccountPopover runs
// its real loader (version fetch, then import ?v=), and the import is resolved to a synthetic
// shell module that keeps the one layer the real shell owns. What is asserted is that layer.
import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { createRenderer, defineComponent, h, nextTick, ref } from "vue";
import { createI18n } from "vue-i18n";
import zh from "../src/i18n/zh.ts";
import en from "../src/i18n/en.ts";
import { resetNames } from "../src/names.ts";
import { createAccountPopover, useAccountPopover, type ProfileCardParams } from "../src/accountPopover.ts";
import { configValue } from "../src/runtimeConfig.ts";
import { loadComponent } from "./render.ts";

type Layer = { kind: "popover" | "card"; uid?: string; at: unknown };
const shell = (globalThis as any).__shell = { log: [] as string[], layer: null as Layer | null };
// One layer, as in nucleagent-web src/account-ui: a mount replaces whatever is open, unmount closes it.
const SHELL = `const s = globalThis.__shell;
export default {
  mount(el) { s.log.push("popover"); s.layer = { kind: "popover", at: el }; },
  unmount() { s.log.push("unmount"); s.layer = null; },
};
export const profileCard = {
  mount(el, p) { s.log.push("card:" + p.uid); s.layer = { kind: "card", uid: p.uid, at: p.host ?? el }; },
  unmount() { s.log.push("unmount"); s.layer = null; },
};`;
registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith("https://nucleagent-web.")) return { url: "data:text/javascript," + encodeURIComponent(SHELL), shortCircuit: true };
    return next(spec, ctx);
  },
});

// Version file per account-ui URL: answered only when the test releases it (cold load in flight).
const versions = new Map<string, () => Promise<Response>>();
const members = Array.from({ length: 50 }, (_, i) => ({ uid: i + 1, username: `u${i + 1}`, displayName: `U${i + 1}`, avatar: "", accountType: "human" }));
const group = { id: 8, creatorUid: 1, title: "G", wukongChannelId: "group_8" };
globalThis.fetch = (async (url: unknown) => {
  const u = String(url);
  const version = versions.get(u.replace(/\?.*$/, ""));
  if (version) return version();
  return new Response(JSON.stringify({ code: 0, data: u.endsWith("/members") ? { group, members } : { items: [], degraded: false } }));
}) as typeof fetch;

let seq = 0;
/** A fresh real instance whose account-ui version answer waits for release(). */
function coldShell(status = 200) {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const url = `https://nucleagent-web.t${++seq}.example/remote/account-ui.js`;
  versions.set(url.replace(/\.js$/, ".version.json"), async () => {
    await gate;
    return status === 200 ? Response.json({ version: "deadbeef" }) : new Response("", { status });
  });
  shell.log.length = 0; shell.layer = null;
  return { ui: createAccountPopover(url), release };
}
async function warmShell() {
  const s = coldShell();
  s.release();
  await s.ui.avatar(); // loads the module, opens nothing
  shell.log.length = 0;
  return s.ui;
}
const card = (uid: string, host: unknown): ProfileCardParams =>
  ({ uid, host, auth: { base: "https://auth.example", token: "j" }, locale: "zh" }) as ProfileCardParams;
const anchor = {} as HTMLElement;

// ---- the group panel, mounted for real; runs first so the app-wide instance is still cold ----

class El {
  children: El[] = []; parentNode: El | null = null; props: Record<string, any> = {}; __v_skip = true;
  tag: string; text: string;
  constructor(tag: string, text = "") { this.tag = tag; this.text = text; }
  get childElementCount() { return this.children.filter((c) => !c.tag.startsWith("#")).length; }
  scrollIntoView() {}
  [Symbol.for("nodejs.util.inspect.custom")]() { return `<${this.tag} ${this.props["data-testid"] ?? ""}>`; }
}
const detach = (n: El) => { const p = n.parentNode; if (p) { p.children.splice(p.children.indexOf(n), 1); n.parentNode = null; } };
const { createApp } = createRenderer<El, El>({
  createElement: (t) => new El(t), createText: (t) => new El("#text", t), createComment: (t) => new El("#comment", t),
  setText: (n, t) => { n.text = t; },
  setElementText: (n, t) => { n.children.forEach(detach); if (t) { const x = new El("#text", t); x.parentNode = n; n.children = [x]; } },
  insert: (c, p, a) => { detach(c); const at = a ? p.children.indexOf(a) : -1; p.children.splice(at < 0 ? p.children.length : at, 0, c); c.parentNode = p; },
  remove: detach, parentNode: (n) => n.parentNode,
  nextSibling: (n) => n.parentNode?.children[n.parentNode.children.indexOf(n) + 1] ?? null,
  patchProp: (n, k, _p, v) => { n.props[k] = v; },
});
const all = (n: El, id: string): El[] => [...(n.props["data-testid"] === id ? [n] : []), ...n.children.flatMap((c) => all(c, id))];
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test("group panel closed while account-ui is still loading: the member card never appears; reopened, it does", async () => {
  (globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  (globalThis as any).window = { addEventListener() {}, removeEventListener() {} };
  (globalThis as any).document = { body: new El("body") };
  // The app-wide instance's URL (tests/fixtures/runtimeConfig.ts), held at its version file.
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  versions.set(configValue("VITE_ACCOUNT_UI_URL").replace(/\.js$/, ".version.json"), async () => { await gate; return Response.json({ version: "deadbeef" }); });
  const Dialog = await loadComponent("src/components/GroupDialog.vue");
  const accountUi = useAccountPopover(); // App.vue's import; the panel's close() is the real one
  const pending: Promise<boolean>[] = [];
  const open = ref(true);
  const Parent = defineComponent(() => () => open.value
    ? h(Dialog as never, { session: { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" }, group,
        // App.vue openProfile: void accountUi.openProfile(anchor, profileParams(..., { host: target.host }))
        onProfile: (row: El, target: { uid: string; host?: unknown }) => { pending.push(accountUi.openProfile(row as never, card(target.uid, target.host))); } })
    : null);
  const root = new El("root");
  const app = createApp(Parent);
  app.use(createI18n({ legacy: false, locale: "zh", fallbackLocale: "zh", messages: { zh, en } as never }));
  const inLiveTree = (n: unknown) => { let x = n as El | null; while (x?.parentNode) x = x.parentNode; return x === root; };
  try {
    app.mount(root);
    await tick();
    shell.log.length = 0; shell.layer = null;
    const rows = () => all(root, "im-member-profile");
    rows()[40].props.onClick({ currentTarget: rows()[40] });
    await tick();
    open.value = false; await nextTick();
    assert.equal(rows().length, 0, "the panel is really gone");
    release();
    await Promise.all(pending);
    assert.deepEqual(shell.log, [], "no card shows up after its panel closed");
    assert.equal(shell.layer, null, "nothing open over the chat");

    open.value = true; await nextTick(); await tick();
    rows()[30].props.onClick({ currentTarget: rows()[30] });
    await Promise.all(pending);
    assert.deepEqual(shell.log, ["card:31"], "a card opened in the reopened panel shows");
    assert.ok(shell.layer?.at === all(root, "im-group-card-host")[0] && inLiveTree(shell.layer?.at), "in the live panel's card area");
  } finally { app.unmount(); resetNames(); }
});

// ---- the shared instance itself, real loader, one fresh instance per case ----

test("cold: closed before account-ui answers, the card never mounts", async () => {
  const { ui, release } = coldShell();
  const opened = ui.openProfile(anchor, card("41", "host-a"));
  ui.close();
  release();
  assert.equal(await opened, true, "the shell is available (not degraded)");
  assert.deepEqual(shell.log, []);
  assert.equal(shell.layer, null);
});

test("cold: the self popover closed before account-ui answers never mounts either", async () => {
  const { ui, release } = coldShell();
  const opened = ui.open(anchor, { user: { nickName: "me", headerImg: "", uid: "1" }, locale: "zh", logout() {}, manageAccount() {} });
  ui.close();
  release();
  assert.equal(await opened, true, "not degraded: the identity chip keeps no fallback open");
  assert.equal(shell.layer, null);
});

test("warm: closed in the same tick as the click, the card does not mount after the close", async () => {
  const ui = await warmShell();
  const opened = ui.openProfile(anchor, card("41", "host-a"));
  ui.close();
  await opened;
  assert.equal(shell.layer, null, "nothing left open");
  assert.ok(!shell.log.includes("card:41") || shell.log.indexOf("card:41") < shell.log.lastIndexOf("unmount"), "never mounted after the close");
});

test("quick switch: only the latest of several cards still loading shows", async () => {
  const { ui, release } = coldShell();
  const a = ui.openProfile(anchor, card("3", "host"));
  const b = ui.openProfile(anchor, card("11", "host"));
  const c = ui.openProfile(anchor, card("41", "host"));
  release();
  assert.deepEqual(await Promise.all([a, b, c]), [true, true, true]);
  assert.deepEqual(shell.log, ["card:41"], "earlier cards never flash in");
  assert.equal(shell.layer?.uid, "41");

  const warm = await warmShell();
  const d = warm.openProfile(anchor, card("3", "host"));
  const e = warm.openProfile(anchor, card("11", "host"));
  await Promise.all([d, e]);
  assert.deepEqual(shell.log, ["card:11"], "same when already loaded");
});

test("normal open and switch are kept: each awaited open mounts, and close unmounts", async () => {
  const ui = await warmShell();
  assert.equal(await ui.openProfile(anchor, card("3", "host")), true);
  assert.equal(await ui.openProfile(anchor, card("11", "host")), true);
  assert.equal(await ui.open(anchor, { user: { nickName: "me", headerImg: "", uid: "1" }, locale: "zh", logout() {}, manageAccount() {} }), true);
  ui.close();
  assert.deepEqual(shell.log, ["card:3", "card:11", "popover", "unmount"]);
  assert.equal(shell.layer, null);
});

test("closed, then a new card opened while the first load is still pending: only the new one shows", async () => {
  const { ui, release } = coldShell();
  const a = ui.openProfile(anchor, card("3", "old-host"));
  ui.close();
  const b = ui.openProfile(anchor, card("41", "new-host"));
  release();
  await Promise.all([a, b]);
  assert.deepEqual(shell.log, ["card:41"]);
  assert.equal(shell.layer?.at, "new-host");
});

test("load failure while closed: degraded, no throw, no mount; a cancelled open does not block the next", async () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { ui, release } = coldShell(503);
    const opened = ui.openProfile(anchor, card("41", "host"));
    ui.close();
    release();
    assert.equal(await opened, false, "unavailable is still reported");
    assert.equal(ui.degraded.value, true);
    assert.deepEqual(shell.log, []);
  } finally { console.warn = warn; }

  const { ui, release } = coldShell();
  const first = ui.openProfile(anchor, card("3", "host"));
  ui.close();
  release();
  await first;
  assert.equal(await ui.openProfile(anchor, card("41", "host")), true);
  assert.deepEqual(shell.log, ["card:41"], "the next open after a cancelled one shows normally");
});

test("repeated close (panel unmounted twice, nothing or something open) never throws and never revives a card", async () => {
  const { ui, release } = coldShell();
  const opened = ui.openProfile(anchor, card("41", "host"));
  ui.close(); ui.close();
  release();
  await opened;
  ui.close(); ui.close();
  assert.equal(shell.layer, null);
  assert.ok(!shell.log.includes("card:41"));
  assert.equal(await ui.openProfile(anchor, card("7", "host")), true);
  ui.close(); ui.close();
  assert.equal(shell.layer, null);
  assert.deepEqual(shell.log.filter((x) => x.startsWith("card:")), ["card:7"]);
});

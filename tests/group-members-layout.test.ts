// IM-GROUP-IMPLEMENT-NOW: group member panel no longer hides its own controls.
// G1 (IM-GROUPUI-DIAG-1): the body was capped at 100vh-108px inside a dialog
// capped at min(760px, 100vh-40px) with overflow:hidden, so "Save" and
// "Dissolve" were clipped and unreachable. Now the dialog is a flex column,
// the body is the one scroller and the actions sit in a footer outside it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { profileActions } from "../src/accountPopover.ts";
import { resetNames } from "../src/names.ts";
import { loadComponent, render } from "./render.ts";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
function decls(selector: string, source = css): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, sel, body] of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!sel.split(",").map((s) => s.trim()).includes(selector)) continue;
    for (const [, k, v] of body.matchAll(/([\w-]+)\s*:\s*([^;]+);/g)) out[k] = v.trim();
  }
  return out;
}

test("G1: group dialog is a flex column, the body scrolls inside it, the footer never scrolls away", () => {
  const dialog = decls(".group-dialog");
  assert.equal(dialog.display, "flex");
  assert.equal(dialog["flex-direction"], "column");
  // A fixed height, not max-height: the picker list closing on pointerdown must
  // not shrink and re-centre the panel, or the footer button moves before
  // mouseup and the click is lost (seen in the browser acceptance).
  const base = css.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, "");
  assert.equal(decls(".group-dialog", base).height, "min(760px, calc(100dvh - 40px))");
  const body = decls(".dialog-body");
  assert.match(body.flex ?? "", /^1\b/);
  assert.equal(body["min-height"], "0");
  assert.equal(body["overflow-y"], "auto");
  assert.equal(body["max-height"] ?? "none", "none", "the body must not carry its own viewport guess");
  assert.equal(decls(".dialog-actions").flex, "none");
});

test("phones: the group dialog is full screen and its actions are 44px touch targets", () => {
  const phone = css.match(/@media \(max-width: 720px\) \{([\s\S]*?)\n\}/g)?.join("\n") ?? "";
  const dialog = decls(".group-dialog", phone);
  assert.equal(dialog.width, "100%");
  assert.equal(dialog.height, "100%");
  assert.equal(dialog["max-height"], "none");
  assert.equal(decls(".dialog-backdrop", phone).padding, "0");
  for (const sel of [".dialog-actions button", ".member-row button", ".check-row", ".group-section-head button", ".dialog-header .icon-button"]) {
    assert.equal(decls(sel)["min-height"], "44px", `${sel} needs a 44px target`);
  }
});

test("G3: the card opened inside the group panel offers no 'Add to group' (it would drop the panel)", () => {
  assert.equal(profileActions({ uid: "5" }, { selfUid: "1", inGroup: true }).addToGroup, false);
  assert.equal(profileActions({ uid: "5" }, { selfUid: "1", inGroup: true }).message, true);
  assert.equal(profileActions({ uid: "5" }, { selfUid: "1" }).addToGroup, true, "elsewhere unchanged");
  const app = readFileSync("src/App.vue", "utf8");
  assert.match(app, /profileActions\(target, \{[\s\S]*?inGroup: groupDialogOpen\.value && !!dialogGroup\.value/);
});

// ---- the component, rendered ----
const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
const group = { id: 8, creatorUid: 1, title: "Test group", wukongChannelId: "group_8" };
const human = (uid: number) => ({ uid, username: `u${uid}`, displayName: `User ${uid}`, avatar: "", accountType: "human" });
const agent = { uid: 37, username: "bot", displayName: "Bot", avatar: "", accountType: "agent" };
const esc = () => ({ key: "Escape", defaultPrevented: false }) as KeyboardEvent;
type Component = { setup: (...args: any[]) => Record<string, any> };

/** Index just past the element that opens at `start` (div depth walk). */
function closeOf(html: string, start: number): number {
  let depth = 0;
  for (const m of html.slice(start).matchAll(/<(\/?)div\b[^>]*>/g)) {
    depth += m[1] ? -1 : 1;
    if (!depth) return start + m.index! + m[0].length;
  }
  return -1;
}

async function mount(memberCount: number) {
  const calls: Array<{ method: string; path: string }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push({ method: init?.method ?? "GET", path });
    let data: unknown = { items: [], degraded: false };
    if (path.includes("/allowlist")) data = { agentUid: 37, memberUids: [], ownerImplicit: true };
    else if (path.endsWith("/members")) data = { group, members: [] };
    return new Response(JSON.stringify({ code: 0, data }));
  };
  const Dialog = await loadComponent("src/components/GroupDialog.vue") as Component;
  const setup = Dialog.setup;
  const events: any[][] = [];
  // Every render() is a fresh instance: `patch` replays the state under test.
  let patch: (state: Record<string, any>) => void = () => {};
  const m = {
    state: {} as Record<string, any>, events, calls,
    draw(next?: (state: Record<string, any>) => void) {
      if (next) patch = next;
      return render(Dialog, { session, group });
    },
    async done() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      globalThis.fetch = original;
      Dialog.setup = setup;
      resetNames();
    },
  };
  Dialog.setup = (props, context) => {
    const state = setup(props, { ...context, emit: (...args: any[]) => events.push(args) });
    state.members.value = [human(1), agent, ...Array.from({ length: memberCount - 2 }, (_, i) => human(100 + i))];
    state.loading.value = false;
    patch(state);
    return (m.state = state);
  };
  await m.draw();
  return m;
}

for (const n of [2, 30, 80]) {
  test(`G1 with ${n} members: save and dissolve live in the footer, outside the scrolling body`, async () => {
    const m = await mount(n);
    try {
      const html = await m.draw();
      const body = html.indexOf('data-testid="im-group-body"');
      const footer = html.indexOf('data-testid="im-group-footer"');
      assert.ok(body > 0 && footer > 0, "body and footer both render");
      assert.ok(footer > closeOf(html, html.lastIndexOf("<div", body)), "footer is not inside the scroll body");
      const foot = html.slice(footer);
      assert.match(foot, /data-testid="im-group-save"/);
      assert.match(foot, /解散群聊/);
    } finally { await m.done(); }
  });
}

test("picker view replaces the member list (never both at once) and Esc steps back one layer", async () => {
  const m = await mount(30);
  try {
    let html = await m.draw();
    assert.match(html, /class="member-list"/);
    assert.doesNotMatch(html, /class="contact-picker/);
    html = await m.draw((state) => { state.view.value = "add"; state.selected.value = [{ id: 500, username: "c", displayName: "C", accountType: "human" }]; });
    assert.match(html, /class="contact-picker/);
    assert.doesNotMatch(html, /class="member-list"/);
    assert.doesNotMatch(html, /im-group-save/, "the add view's footer is add/cancel, not save");
    m.state.onKey(esc());
    assert.equal(m.state.view.value, "members");
    assert.deepEqual(m.state.selected.value, [], "leaving the picker drops its picks, like Cancel");
    assert.equal(m.events.length, 0, "Esc in the picker does not close the panel");
    m.state.onKey(esc());
    assert.deepEqual(m.events.at(-1), ["close"]);
  } finally { await m.done(); }
});

test("remove asks first: one click arms an inline confirm, only the confirm deletes, Esc disarms", async () => {
  const m = await mount(3);
  try {
    const html = await m.draw((state) => { state.removing.value = 100; });
    const target = m.state.members.value[2];
    assert.match(html, /data-testid="im-member-remove-confirm"/);
    assert.equal(m.calls.filter((c) => c.method === "DELETE").length, 0, "arming does not delete");
    m.state.onKey(esc());
    assert.equal(m.state.removing.value, undefined);
    assert.equal(m.events.length, 0, "Esc disarms, it does not close the panel");
    await m.state.removeMember(target);
    assert.ok(m.calls.some((c) => c.method === "DELETE" && /\/groups\/8\/members\/100$/.test(c.path)));
  } finally { await m.done(); }
});

test("Esc already handled by a layer above (the shared profile card) leaves the panel alone", async () => {
  const m = await mount(2);
  try {
    m.state.onKey({ ...esc(), defaultPrevented: true });
    assert.equal(m.events.length, 0);
  } finally { await m.done(); }
});

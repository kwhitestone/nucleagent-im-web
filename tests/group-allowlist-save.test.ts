// IM-GROUP-BLOCKERS-FIX-NOW: the independent review's probes (IM-GROUP-FINAL-REVIEW-NOW
// R1-R12, /tmp/imgfr) adopted as product tests. R3 is tightened to per-agent feedback
// and retry; R9 asserts the card's in-panel host instead of a pattern on App.vue.
// Fetch is a scripted fake with the backend's semantics: component-level facts only,
// not DEV/real-App evidence.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resetNames } from "../src/names.ts";
import { loadComponent, render } from "./render.ts";

type Call = { method: string; path: string; body?: any };
type Component = { setup: (...args: any[]) => Record<string, any> };
const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
const group = { id: 8, creatorUid: 1, title: "G", wukongChannelId: "group_8" };
const human = (uid: number) => ({ uid, username: `u${uid}`, displayName: `U${uid}`, avatar: "", accountType: "human" });
const bot = (uid: number) => ({ uid, username: `b${uid}`, displayName: `B${uid}`, avatar: "", accountType: "agent" });

/**
 * Server fake with real backend semantics (im groups.go:404 replaceAllowlist):
 * whole-list replace, 404 if any uid is no longer a member. `server` is mutable so a
 * test can model a second owner tab / member leaving between open and Save.
 */
async function mount(opts: { creator?: number; failPutFor?: number } = {}) {
  opts = { ...opts };
  const server = {
    members: [human(1), human(2), human(3), bot(37), bot(38)],
    allow: { 37: [2], 38: [3] } as Record<number, number[]>,
  };
  const calls: Call[] = [];
  const original = globalThis.fetch;
  const ok = (data: unknown) => new Response(JSON.stringify({ code: 0, data }));
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const al = path.match(/agents\/(\d+)\/allowlist$/);
    if (al) {
      const agent = Number(al[1]);
      if (method === "PUT") {
        if (agent === opts.failPutFor) return new Response(JSON.stringify({ code: 1, message: "im_unavailable" }), { status: 503 });
        const uids: number[] = body.memberUids;
        if (uids.some((u) => !server.members.some((m) => m.uid === u))) {
          return new Response(JSON.stringify({ code: 1, message: "member_not_found" }), { status: 404 });
        }
        server.allow[agent] = [...uids];
      }
      return ok({ agentUid: agent, memberUids: server.allow[agent] ?? [], ownerImplicit: true });
    }
    if (path.endsWith("/members")) return ok({ group: { ...group, creatorUid: opts.creator ?? 1 }, members: server.members });
    return ok({});
  };
  const Dialog = await loadComponent("src/components/GroupDialog.vue") as Component;
  const setup = Dialog.setup;
  const events: any[][] = [];
  let state: Record<string, any> = {};
  let freeze = false; // SSR re-render: show loaded members instead of the fresh instance's loading state
  Dialog.setup = (props, context) => {
    const s = setup(props, { ...context, emit: (...a: any[]) => events.push(a) });
    if (!freeze) return (state = s);
    s.members.value = server.members; s.loading.value = false;
    return s;
  };
  const g = { ...group, creatorUid: opts.creator ?? 1 };
  const html = async () => { freeze = true; try { return await render(Dialog, { session, group: g }); } finally { freeze = false; } };
  await render(Dialog, { session, group: g });
  await new Promise((r) => setTimeout(r, 30)); // load(): members + allowlists
  return {
    server, calls, events, html, opts, get s() { return state; },
    async done() { globalThis.fetch = original; Dialog.setup = setup; resetNames(); },
  };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === "PUT");

test("R1: Save writes only agents the owner changed (another tab's edit to an untouched agent survives)", async () => {
  const m = await mount();
  try {
    assert.deepEqual(m.s.allowlistDrafts.value, { 37: [2], 38: [3] }, "precondition: snapshot loaded");
    m.server.allow[38] = [2, 3]; // second owner tab (or master's per-agent Save) edits agent 38
    m.s.toggleAllowlist(37, 3); // this panel edits agent 37 only
    await m.s.saveAllowlists();
    assert.deepEqual(m.server.allow[37], [2, 3]);
    assert.deepEqual(m.server.allow[38], [2, 3], "untouched agent 38 was overwritten with the stale snapshot");
  } finally { await m.done(); }
});

test("R2: a member who left after the panel opened does not make Save fail for an agent nobody touched", async () => {
  const m = await mount();
  try {
    m.server.members = m.server.members.filter((x) => x.uid !== 3); // backend also drops 3's allowlist rows (groups.go:320)
    m.server.allow[38] = [];
    m.s.toggleAllowlist(37, 3); m.s.toggleAllowlist(37, 3); // net no-op on 37
    m.s.toggleAllowlist(37, 2); // real change: remove 2 from 37
    await m.s.saveAllowlists();
    assert.deepEqual(m.server.allow[37], [], "the change the owner made is saved");
    assert.equal(m.s.error.value, "", "no error caused by agent 38's stale [3]");
  } finally { await m.done(); }
});

test("R3: one agent failing does not drop the others; the owner sees which agent failed and Save retries only it", async () => {
  const m = await mount({ failPutFor: 37 });
  try {
    m.s.toggleAllowlist(37, 3);
    m.s.toggleAllowlist(38, 2);
    await m.s.saveAllowlists();
    assert.deepEqual(m.server.allow[38], [3, 2], "agent 38 saved although 37 failed first");
    assert.deepEqual(m.server.allow[37], [2], "37 not written");
    assert.deepEqual(m.s.allowlistDrafts.value[37], [2, 3], "the failed agent keeps its draft");
    assert.ok(m.s.saveErrors.value[37], "37 carries its own error");
    assert.equal(m.s.saveErrors.value[38], undefined, "38 has none");
    assert.match(m.s.error.value, /B37/, "the summary names the failed agent");
    assert.doesNotMatch(m.s.error.value, /B38/);
    const html = await m.html();
    assert.match(html, /data-testid="im-allowlist-error"/, "the failed agent's block shows its error");
    // retry: only the failed agent is sent again
    m.opts.failPutFor = undefined;
    const before = m.calls.length;
    await m.s.saveAllowlists();
    assert.deepEqual(puts(m.calls.slice(before)).map((c) => c.path.match(/agents\/(\d+)/)![1]), ["37"]);
    assert.deepEqual(m.server.allow[37], [2, 3]);
    assert.equal(m.s.error.value, "");
    assert.deepEqual(m.s.saveErrors.value, {});
  } finally { await m.done(); }
});

test("R2b: a member who left is dropped from a changed agent's list instead of failing it", async () => {
  const m = await mount();
  try {
    m.s.toggleAllowlist(37, 3); // owner adds 3 to agent 37 ...
    m.server.members = m.server.members.filter((x) => x.uid !== 3); // ... but 3 left meanwhile
    m.server.allow[38] = [];
    await m.s.saveAllowlists();
    assert.deepEqual(m.server.allow[37], [2], "saved without the departed member");
    assert.equal(m.s.error.value, "");
    assert.ok(!m.s.members.value.some((x: { uid: number }) => x.uid === 3), "the list drops the departed member");
  } finally { await m.done(); }
});

test("R1b: Save with nothing changed sends no write", async () => {
  const m = await mount();
  try {
    m.s.toggleAllowlist(37, 3); m.s.toggleAllowlist(37, 3);
    await m.s.saveAllowlists();
    assert.equal(puts(m.calls).length, 0);
  } finally { await m.done(); }
});

test("R4: Save sends exactly the drafted list per agent and refreshes the stored allowlist", async () => {
  const m = await mount();
  try {
    m.s.toggleAllowlist(37, 3);
    await m.s.saveAllowlists();
    const p = puts(m.calls).find((c) => c.path.endsWith("/agents/37/allowlist"));
    assert.deepEqual(p?.body, { memberUids: [2, 3] });
    assert.deepEqual(m.s.allowlists.value[37].memberUids, [2, 3]);
    assert.equal(m.s.saving.value, false);
  } finally { await m.done(); }
});

test("R5: dissolve asks, cancel sends nothing; confirm DELETEs the group and emits removed", async () => {
  const m = await mount();
  const prev = (globalThis as any).window;
  let answer = false;
  (globalThis as any).window = { ...(prev ?? {}), confirm: () => answer, addEventListener() {}, removeEventListener() {} };
  try {
    await m.s.destroy();
    assert.equal(m.calls.filter((c) => c.method === "DELETE").length, 0);
    assert.equal(m.events.length, 0);
    answer = true;
    await m.s.destroy();
    assert.ok(m.calls.some((c) => c.method === "DELETE" && /\/groups\/8$/.test(c.path)), "DELETE /groups/8");
    assert.equal(m.events.at(-1)?.[0], "removed");
  } finally { (globalThis as any).window = prev; await m.done(); }
});

test("R6: footer offers Leave (not Dissolve/Save) to a non-owner", async () => {
  const m = await mount({ creator: 2 });
  try {
    const html = await m.html();
    const foot = html.slice(html.indexOf('data-testid="im-group-footer"'));
    assert.match(foot, /退出群聊/);
    assert.doesNotMatch(foot, /解散群聊|im-group-save/);
    assert.equal(m.calls.filter((c) => c.path.includes("/allowlist")).length, 0, "non-owner never reads allowlists");
  } finally { await m.done(); }
});

test("R7: confirmed remove deletes exactly that member and reloads allowlists", async () => {
  const m = await mount();
  try {
    m.s.removing.value = 3;
    const before = m.calls.length;
    await m.s.removeMember(human(3));
    const after = m.calls.slice(before);
    assert.deepEqual(after.filter((c) => c.method === "DELETE").map((c) => c.path.replace(/^.*\/api/, "")), ["/v1/im/groups/8/members/3"]);
    assert.ok(after.some((c) => c.path.endsWith("/members") && c.method === "GET"), "reload after delete");
    assert.equal(m.s.removing.value, undefined);
    assert.deepEqual(m.events.at(-1), ["changed"]);
  } finally { await m.done(); }
});

test("R8: Esc order — armed remove, then picker, then close; a handled Esc does nothing", async () => {
  const m = await mount();
  try {
    const esc = (defaultPrevented = false) => m.s.onKey({ key: "Escape", defaultPrevented } as KeyboardEvent);
    m.s.view.value = "add"; m.s.removing.value = 2;
    esc(true);
    assert.equal(m.s.removing.value, 2); assert.equal(m.s.view.value, "add");
    esc(); assert.equal(m.s.removing.value, undefined); assert.equal(m.s.view.value, "add");
    esc(); assert.equal(m.s.view.value, "members"); assert.equal(m.events.length, 0);
    m.s.onKey({ key: "Enter", defaultPrevented: false } as KeyboardEvent); assert.equal(m.events.length, 0);
    esc(); assert.deepEqual(m.events.at(-1), ["close"]);
  } finally { await m.done(); }
});

test("R9 G2: a member's card opens in the panel's own card area, not as a body layer over the list", async () => {
  const m = await mount();
  try {
    const html = await m.html();
    const host = html.indexOf('data-testid="im-group-card-host"');
    assert.ok(host > 0, "the panel has a card area");
    assert.ok(host < html.indexOf('data-testid="im-group-body"'), "outside (above) the scrolling member list");
    assert.ok(host < html.indexOf('data-testid="im-group-footer"'));
    const anchor = { tag: "row" } as unknown as HTMLElement;
    const cardHost = { tag: "host" } as unknown as HTMLElement;
    m.s.cardHost.value = cardHost;
    m.s.inspect({ ...bot(37) }, anchor);
    const [name, a, target] = m.events.at(-1)!;
    assert.equal(name, "profile"); assert.equal(a, anchor);
    assert.equal(target.host, cardHost, "the card is told to render inside the panel");
  } finally { await m.done(); }
  const app = readFileSync("src/App.vue", "utf8");
  const open = app.slice(app.indexOf("function openProfile"), app.indexOf("function senderProfile"));
  assert.match(open, /host: target\.host/, "App forwards the host to the shared card");
  const api = readFileSync("src/accountPopover.ts", "utf8");
  assert.match(api, /"onSelect" \| "host"/, "profileParams passes host through");
});

test("R10: confirming Add posts the picks, clears them and returns to the member list", async () => {
  const m = await mount();
  try {
    m.s.view.value = "add";
    m.s.selected.value = [{ id: 500, username: "c", displayName: "C", accountType: "human" }];
    await m.s.addMembers();
    const post = m.calls.find((c) => c.method === "POST" && /\/groups\/8\/members$/.test(c.path));
    assert.ok(post, "POST /groups/8/members");
    assert.equal(m.s.view.value, "members");
    assert.deepEqual(m.s.selected.value, []);
    assert.deepEqual(m.events.at(-1), ["changed"]);
  } finally { await m.done(); }
});

// Static checks (SSR harness cannot fire DOM keydown or unmount; brief forbids a new renderer).
test("R11 (static): the picker's open-list Esc marks itself handled so the panel stays open", () => {
  const picker = readFileSync("src/components/ContactPicker.vue", "utf8");
  assert.match(picker, /@keydown\.esc="open && \(\$event\.preventDefault\(\), open = false\)"/);
});

test("R12 (static): unmounting the panel closes the shared member card", () => {
  const dialog = readFileSync("src/components/GroupDialog.vue", "utf8");
  const hook = dialog.slice(dialog.indexOf("onBeforeUnmount("), dialog.indexOf("</script>"));
  assert.match(hook, /useAccountPopover\(\)\.close\(\)/);
});

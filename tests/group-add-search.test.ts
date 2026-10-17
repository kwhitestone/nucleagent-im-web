// IM-GROUP-MEMBER-SEARCH-1215: the group "Add members" picker searches like the
// search page — same directory search, row = profile card (in the dialog), the
// card's Select picks, members already in the group are greyed and never re-added.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadComponent, render } from "./render.ts";

const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
const picker = readFileSync("src/components/ContactPicker.vue", "utf8");
const dialog = readFileSync("src/components/GroupDialog.vue", "utf8");
const person = (id: number, name = "赖碧威") => ({ id, username: `u${id}`, displayName: name, accountType: "human", provisioned: true });

async function mounted(props: Record<string, unknown>, state: Record<string, unknown> = {}) {
  const C = await loadComponent("src/components/ContactPicker.vue") as { setup: (p: unknown, c: { emit: (...a: unknown[]) => void }) => Record<string, { value: unknown }> };
  const original = C.setup;
  const emitted: unknown[][] = [];
  let bindings: Record<string, unknown> = {};
  C.setup = function (this: unknown, p, ctx) {
    bindings = original.call(this, p, { ...ctx, emit: (...a: unknown[]) => emitted.push(a) });
    for (const [k, v] of Object.entries(state)) (bindings[k] as { value: unknown }).value = v;
    return bindings;
  };
  try { return { html: await render(C, { session, multiple: true, ...props }), bindings, emitted }; } finally { C.setup = original; }
}

test("reuses the search page's directory search, paging and same-name sub-line", () => {
  assert.match(picker, /searchDirectory\(value, props\.session\)/);
  assert.match(picker, /searchDirectory\(query\.value, props\.session, page\.value \+ 1\)/, "load more pages, not only page 1");
  assert.match(picker, /directorySub\(contact, t\)/, "same @username · UID · enterprise marker as the search page");
  assert.doesNotMatch(picker, /fetch\(/, "no second search transport");
});

test("both same-named accounts list apart, each row opens the card with Select, nothing picked yet", async () => {
  const { html, bindings, emitted } = await mounted({}, { query: "赖碧威", results: [person(1), person(15)], hasMore: true });
  assert.equal(html.match(/data-testid="im-picker-row"/g)?.length, 2);
  assert.match(html, /UID 1\b[\s\S]*UID 15\b/);
  assert.match(html, /contact-more/, "more results reachable");
  const host = { contains: () => false };
  (bindings.inspect as (e: unknown, a: unknown) => void)(person(15), { id: "row" });
  const [, , target] = emitted.find((e) => e[0] === "profile") as [string, unknown, { uid: string; select?: unknown; host?: unknown }];
  assert.equal(target.uid, "15");
  assert.equal(typeof target.select, "function");
  assert.equal(emitted.some((e) => e[0] === "update:modelValue"), false, "a row click does not select");
  void host;
});

test("the card renders in the dialog's card host, not over the dialog", async () => {
  const host = { contains: () => false, tag: "host" };
  const { bindings, emitted } = await mounted({ cardHost: host });
  (bindings.inspect as (e: unknown, a: unknown) => void)(person(1), {});
  const target = (emitted.find((e) => e[0] === "profile") as [string, unknown, { host?: unknown }])[2];
  assert.equal(target.host, host);
  assert.match(dialog, /<div ref="cardHost" class="group-card-host"[^>]*\/>\s*<form v-if="!group"/, "create mode has the host too");
  assert.equal(dialog.match(/:card-host="cardHost"/g)?.length, 2);
  assert.equal(dialog.match(/@profile="\(anchor, target\) => emit\('profile', anchor, target\)"/g)?.length, 2, "N1: picker profile reaches the opener");
});

test("members already in the group: greyed, 已在群中, no Select, choose refuses", async () => {
  const { html, bindings, emitted } = await mounted({ inGroupUids: [15] }, { query: "赖碧威", results: [person(1), person(15)] });
  assert.equal(html.match(/data-testid="im-picker-in-group"/g)?.length, 1);
  assert.match(html, /in-group[\s\S]*已在群中/);
  (bindings.inspect as (e: unknown, a: unknown) => void)(person(15), {});
  const target = (emitted.find((e) => e[0] === "profile") as [string, unknown, { select?: unknown }])[2];
  assert.equal(target.select, undefined);
  await (bindings.choose as (e: unknown) => Promise<void>)(person(15));
  assert.equal(emitted.some((e) => e[0] === "update:modelValue"), false);
  assert.match(dialog, /:in-group-uids="members\.map\(\(member\) => member\.uid\)"/);
});

test("selected tags are removable buttons; rows are keyboard-reachable buttons", async () => {
  const { html } = await mounted({ modelValue: [person(1)] }, { query: "赖碧威", results: [person(15)] });
  assert.match(html, /<button class="selection" type="button" aria-label="移除 赖碧威"/);
  assert.match(html, /<button class="contact-result"[^>]*type="button"[^>]*role="option"/);
});

test("clicks inside the card host keep the picker list open", () => {
  assert.match(picker, /if \(props\.cardHost\?\.contains\(event\.target as Node\)\) return;/);
});

// UNI-IMUX3: the four entry points to the shared profile card (board §03):
// chat header title, message sender, group member row, picker ⓘ. The card
// itself is the shell's account-ui module (nucleagent-web
// tests/accountPopover.test.ts); here we pin the wiring on this side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadComponent, render } from "./render.ts";

const app = readFileSync("src/App.vue", "utf8");

test("chat header: a direct chat's title is a button that opens the card", () => {
  const header = app.slice(app.indexOf('<header class="chat-header">'), app.indexOf("</header>", app.indexOf('<header class="chat-header">')));
  assert.match(header, /data-testid="im-header-profile"[\s\S]*@click="headerProfile"/);
  assert.match(header, /v-if="activeTitle && activeChannel\?\.channelType === ChannelTypePerson"/, "groups keep a plain title");
  assert.match(app, /function headerProfile[\s\S]*?openProfile\(event\.currentTarget as HTMLElement, \{\s*uid: channel\.channelID/);
});

test("message sender: another person's name is a button; own messages are not", () => {
  const sender = app.slice(app.indexOf('<span class="sender">'), app.indexOf("</span>", app.indexOf("im-sender-profile")));
  assert.match(sender, /v-if="isOwnMessage\(message\)"/);
  assert.match(sender, /data-testid="im-sender-profile"[\s\S]*@click="senderProfile\(message, \$event\)"/);
  assert.match(app, /function senderProfile[\s\S]*?if \(isOwnMessage\(message\)\) return;[\s\S]*?uid: message\.fromUID/);
});

test("picker and group dialog forward their profile events to the one opener", () => {
  assert.match(app, /<ContactPicker[\s\S]*?@profile="openProfile"/);
  assert.match(app, /<GroupDialog[\s\S]*?@profile="openProfile"/);
  assert.match(app, /accountUi\.openProfile\(anchor, profileParams\(session\.value/);
});

const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };

/** Renders an SFC and hands back its setup bindings, so a test can call a handler. */
async function withBindings(path: string, props: Record<string, unknown>) {
  const component = await loadComponent(path) as { setup: (p: unknown, c: { emit: (...a: unknown[]) => void }) => Record<string, unknown> };
  const emitted: unknown[][] = [];
  const original = component.setup;
  let bindings: Record<string, unknown> = {};
  component.setup = function (this: unknown, p: unknown, ctx: { emit: (...a: unknown[]) => void }) {
    bindings = original.call(this, p, { ...ctx, emit: (...args: unknown[]) => emitted.push(args) });
    return bindings;
  };
  try {
    const html = await render(component, props, "en");
    return { html, bindings, emitted };
  } finally {
    component.setup = original;
  }
}

test("picker ⓘ: a separate 44px button per row whose card picks that person", async () => {
  const src = readFileSync("src/components/ContactPicker.vue", "utf8");
  assert.equal(src.match(/data-testid="im-picker-info"/g)?.length, 2, "browse and search rows alike");
  assert.match(src, /:aria-label="t\('profile\.view', \{ name: rowName\(contact\) \}\)"/);
  const css = readFileSync("src/style.css", "utf8");
  assert.match(css, /\.contact-info \{[^}]*width: 44px;[^}]*height: 44px;/);

  const { bindings, emitted } = await withBindings("src/components/ContactPicker.vue", { session });
  const inspect = bindings.inspect as (entry: unknown, el: unknown) => void;
  const anchor = { id: "i" };
  inspect({ id: 14, username: "lin.yu", displayName: "林雨", accountType: "human", provisioned: true }, anchor);
  inspect({ id: 0, portalUid: 88, username: "portal_3f9a", displayName: "陈雨桐", accountType: "human", provisioned: false }, anchor);
  const [first, second] = emitted.filter((e) => e[0] === "profile") as Array<[string, unknown, { uid: string; portalUid?: number; known: Record<string, unknown>; select: unknown }]>;
  assert.equal(first[1], anchor);
  assert.equal(first[2].uid, "14");
  assert.equal(first[2].known.username, "lin.yu");
  assert.equal(typeof first[2].select, "function", "the card's primary is Select");
  assert.deepEqual([second[2].uid, second[2].portalUid, second[2].known.provisioned], ["", 88, false], "portal-only: by portalUid, never uid 0");
});

// GroupDialog imports ContactPicker.vue, which the SFC harness cannot nest, so
// its wiring is pinned from source (the picker above is exercised live).
const dialog = readFileSync("src/components/GroupDialog.vue", "utf8");

test("group member: the name is a button that opens that member's card", () => {
  assert.match(dialog, /data-testid="im-member-profile"[\s\S]*@click="inspect\(member, \$event\.currentTarget as HTMLElement\)"/);
  assert.match(dialog, /function inspect\(member: GroupMember, anchor: HTMLElement\)[\s\S]*?emit\("profile", anchor, \{\s*uid: String\(member\.uid\),[\s\S]*?avatar: member\.avatar,[\s\S]*?accountType: member\.accountType/);
});

test("group dialog preselects people passed by the card's Add to group", () => {
  assert.match(dialog, /const selected = ref<Contact\[\]>\(\[\.\.\.\(props\.preselect \?\? \[\]\)\]\);/);
  assert.match(app, /onAddToGroup: !can\.addToGroup \? undefined : \(\) => \{[\s\S]*?showCreateGroup\(\[contact\(\)\]\)/);
});

// UNI-IMUX4: the DM header sub-line (board §03 anno 1) and the rail's own
// popover rows (board §05) read @username / Enterprise from the resolve cache.
test("DM header sub-line is '@username · Enterprise' from resolve, else the old label", () => {
  assert.match(app, /const directMeta = computed\(\(\) => \{[\s\S]*?handleFor\(channel\.channelID, contact\?\.username\)[\s\S]*?isEnterprise\(channel\.channelID\)/);
  assert.match(app, /: directMeta \|\| t\("chat\.directMessage"\)/);
  assert.match(app, /!isAgentUid\(channel\.channelID\) && isEnterprise/, "agents never read Enterprise");
});

test("rail Me: the popover gets @username, account kind and enterprise from the resolve cache", async () => {
  const { ensureNames, resetNames } = await import("../src/names.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { degraded: false, items: [
    { uid: 1, profile: { nickName: "赖碧威", avatar: "", accountType: "human", provisioned: true, username: null, enterprise: true, openId: "nduc_nd_1" } },
    { uid: 5, profile: { nickName: "Ops", avatar: "", accountType: "human", provisioned: true, username: "ops", enterprise: false, openId: null } },
    { uid: 6, profile: { nickName: "Old auth", avatar: "", accountType: "human", provisioned: true } },
  ] } }), { status: 200 });
  try {
    await ensureNames(["1", "5", "6"], session);
  } finally { globalThis.fetch = original; }
  const card = readFileSync("src/components/IdentityCard.vue", "utf8");
  assert.match(card, /username: handleFor\(props\.uid\) \|\| undefined, accountType: accountTypeOf\(props\.uid\), enterprise: isEnterprise\(props\.uid\)/);
  assert.match(card, /openId: openIdOf\(props\.uid\)/, "UNI-PROFILE1: the unified card's Agentia Open ID row");
  const { handleFor, isEnterprise, accountTypeOf, openIdOf } = await import("../src/names.ts");
  assert.deepEqual([handleFor("1"), accountTypeOf("1"), isEnterprise("1")], ["", "human", true], "portal self: no handle, Enterprise");
  assert.deepEqual([openIdOf("1"), openIdOf("5"), openIdOf("6"), openIdOf("7")], ["nduc_nd_1", null, undefined, undefined],
    "linked / none recorded / older auth / not resolved");
  resetNames();
});

// UNI-CARDCONT: the rail's "Me" is the same self card as the shell's, so it
// carries the same rows: user-info roles (the shell's Roles row) and the
// masked phone from the resolve cache. Never a raw phone: im-web only ever
// holds auth's phoneMasked.
test("rail Me: the popover gets roles from user-info and the masked phone, like the shell's self card", async () => {
  const card = readFileSync("src/components/IdentityCard.vue", "utf8");
  assert.match(card, /uid: props\.uid, roles: props\.roles,/);
  assert.match(card, /phoneMasked: phoneMaskedOf\(props\.uid\)/);
  assert.match(app, /<IdentityCard[\s\S]*?:roles="profileRoles"/);
  assert.match(app, /profileRoles\.value = profile\.roles \?\? \[\];/, "refreshed from user-info");
  assert.match(app, /profileRoles\.value = \[\];/, "cleared on teardown: no roles leak into the next account");
  const { ensureNames, phoneMaskedOf, resetNames } = await import("../src/names.ts");
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ code: 0, data: { degraded: false, items: [
    { uid: 1, profile: { nickName: "赖碧威", avatar: "", accountType: "human", provisioned: true, phoneMasked: "138****1234" } },
    { uid: 5, profile: { nickName: "Ops", avatar: "", accountType: "human", provisioned: true, phoneMasked: null } },
  ] } }), { status: 200 });
  try {
    await ensureNames(["1", "5"], session);
  } finally { globalThis.fetch = original; }
  assert.deepEqual([phoneMaskedOf("1"), phoneMaskedOf("5"), phoneMaskedOf("7")], ["138****1234", null, undefined]);
  resetNames();
});

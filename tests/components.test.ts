import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent, openExpanded, render } from "./render.ts";

const IdentityCard = await loadComponent("src/components/IdentityCard.vue");
const EmptyPaths = await loadComponent("src/components/EmptyPaths.vue");
const SystemLine = await loadComponent("src/components/SystemLine.vue");

const openCard = (props: Record<string, unknown>, locale: "zh" | "en" = "zh") =>
  openExpanded(IdentityCard, props, locale);

// --- identity card -----------------------------------------------------------
// The reported gap: session.uid lived only in memory and was never rendered, so
// a user could not find their own ID to give to a colleague.

// The card is collapsed until clicked, so these assert on the avatar initial
// the rail always shows. `openCard` covers the expanded profile.
test("the collapsed card shows an initial derived from the resolved name", async () => {
  const html = await render(IdentityCard, { uid: "10480118", displayName: "Chen Mo" }, "en");
  assert.match(html, />C</);
  assert.match(html, /identity-chip/);
});

// The expanded state below is the degraded card (account-ui failed to load):
// avatar + name only, no actions. The loaded popover is the shell's module,
// covered by nucleagent-web tests/accountPopover.test.ts.
test("fallback: a missing profile name falls back to Portal user <uid>, never a blank", async () => {
  const html = await openCard({ uid: "10480118" });
  assert.match(html, /im-identity-fallback/);
  assert.match(html, /Portal user 10480118/);
  // The initial comes from that fallback rather than rendering empty.
  assert.match(html, />P</);
});

test("fallback: a resolved profile name wins over the placeholder", async () => {
  const html = await openCard({ uid: "10480118", displayName: "Chen Mo" }, "en");
  assert.match(html, /Chen Mo/);
  assert.doesNotMatch(html, /Portal user/);
});

test("fallback: a whitespace-only profile name is treated as absent", async () => {
  const html = await openCard({ uid: "10480118", displayName: "   " });
  assert.match(html, /Portal user 10480118/);
});

// UNI-ACCTUI: degraded means display only — no account, sign-out, or copy actions.
test("fallback: avatar and name only, no actions and no error", async () => {
  const html = await openCard({ uid: "10480118", displayName: "Chen Mo" }, "en");
  assert.equal(html.match(/<button/g)?.length, 1, "only the chip is a button");
  const text = html.replace(/<!--[\s\S]*?-->|<[^>]+>/g, " ");
  assert.doesNotMatch(text, /Account|Sign out|Copy|error/i);
});

test("collapsed: the chip is the popover trigger and renders nothing else", async () => {
  const html = await render(IdentityCard, { uid: "10480118", displayName: "Chen Mo" }, "en");
  assert.match(html, /data-testid="im-identity-chip"/);
  assert.doesNotMatch(html, /identity-pop/);
});

// --- empty state -------------------------------------------------------------

test("the empty state offers all three paths with their when-to-use lines", async () => {
  const html = await render(EmptyPaths, {}, "en");
  assert.match(html, /Search people and agents/);
  assert.match(html, /Add by UID/);
  assert.match(html, /Create a group/);
  // Each path says when to use it, not just what it is called.
  assert.match(html, /2 characters minimum/);
  assert.match(html, /digits only/);
  // The one product rule the old UI never stated.
  assert.match(html, /@-mentions only work in groups/);
});

test("exactly one path is primary, so the three are not equally weighted", async () => {
  const html = await render(EmptyPaths);
  assert.equal((html.match(/class="path primary"/g) || []).length, 1);
  assert.equal((html.match(/class="path[ "]/g) || []).length, 3);
});

test("the empty state is translated, not hardcoded English", async () => {
  const html = await render(EmptyPaths, {}, "zh");
  assert.match(html, /还没有会话/);
  assert.match(html, /按 UID 添加/);
  assert.doesNotMatch(html, /Add by UID/);
});

// --- system line -------------------------------------------------------------

test("a system line carries an action only when one is given", async () => {
  const withAction = await render(SystemLine, { action: "Reconnect" });
  assert.match(withAction, /Reconnect/);
  const plain = await render(SystemLine, {});
  assert.doesNotMatch(plain, /sysline-act/);
});

/**
 * Tone is the point of the calm variant: a dropped connection heals itself and
 * must not shout, while a 429 needs the user to change what they are doing.
 * They also differ in ARIA weight, so a screen reader interrupts only for the
 * one that needs attention.
 */
test("calm system lines are announced politely, alarming ones assertively", async () => {
  const calm = await render(SystemLine, { calm: true });
  assert.match(calm, /class="sysline calm"/);
  assert.match(calm, /role="status"/);

  const alarming = await render(SystemLine, {});
  assert.doesNotMatch(alarming, /calm/);
  assert.match(alarming, /role="alert"/);
});

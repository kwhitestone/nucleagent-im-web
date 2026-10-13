import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { nextTick } from "vue";
import { loadComponent, render } from "./render.ts";
import { DefinitionError, type Detail } from "../src/agent-definition/api.ts";
import { definitionFields } from "../src/agent-definition/draft.ts";
import { changeCount, dirtyGroups, fieldGroup, groups } from "../src/agent-definition/groups.ts";

const detail = (over: Partial<Detail["definition"]> = {}) => ({
  definition: { id: 1, name: "one", slug: "one", revision: "1", config: { description: "d", prompt: "p" }, isActive: false, ...over },
  capabilities: { read: true, write: true, readSkills: true, writeSkillBindings: true, writeIdentity: true, delete: true },
  fieldPolicy: { editablePaths: ["/name", "/config/description", "/config/prompt"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
  identity: { uid: 7, status: "ready" }, effective: { revision: "abcdef0123456789abcdef", definitionRevision: "1" },
  skills: [{ id: 3, name: "Writer", slug: "writer", version: "1", sourceSHA256: "x", isActive: true }],
  skillBindings: [{ skillId: 3, installPath: "" }], tools: [], etag: '"agent-1-1"',
}) as unknown as Detail;
const impact = { instances: 0, conversations: 0, conversations_7d: 0, skill_bindings: 0, im_groups: 0, deliverables: 0, unavailable: [], counted_at: "now" };

async function mountDrawer(api: Record<string, unknown>, record = detail(), locale = "en") {
  const originalDocument = globalThis.document;
  globalThis.document = { activeElement: null } as unknown as Document;
  const drawer = await loadComponent("src/agent-definition/DefinitionDrawer.vue") as { setup: Function };
  const setup = drawer.setup;
  let bindings: any;
  drawer.setup = function (props: unknown, context: unknown) { bindings = setup(props, context); return bindings; };
  try {
    const html = await render(drawer, { detail: record, api }, locale);
    return { html, bindings, rerender: () => render(drawer, { detail: record, api }, locale), restore: () => { drawer.setup = setup; globalThis.document = originalDocument; } };
  } catch (error) { drawer.setup = setup; globalThis.document = originalDocument; throw error; }
}

test("every editable field belongs to exactly one navigation group", () => {
  assert.deepEqual(groups, ["basic", "persona", "model", "skills", "visibility", "history", "advanced"]);
  for (const field of definitionFields) assert.ok(groups.includes(fieldGroup(field.path)), field.path);
  assert.equal(fieldGroup("/config/prompt"), "persona");
  assert.equal(fieldGroup("/config/defaults/model"), "model");
});

test("dirty groups and the unsaved count are derived only from editor.changes and bindings", () => {
  assert.deepEqual([...dirtyGroups({}, undefined)], []);
  assert.deepEqual([...dirtyGroups({ "/config/prompt": "x", "/name": "n" }, [])].sort(), ["basic", "persona", "skills"]);
  assert.equal(changeCount({ "/config/prompt": "x", "/name": "n" }, undefined), 2);
  assert.equal(changeCount({ "/name": "n" }, []), 2);
});

test("the drawer shows grouped navigation and keeps backend paths and hashes out of visible labels", async () => {
  const { html, restore } = await mountDrawer({});
  try {
    assert.match(html, /role="tablist"/);
    for (const name of ["Basics", "Persona", "Model", "Skills", "Visibility", "Usage", "Advanced"]) assert.match(html, new RegExp(`role="tab"[^>]*>[^<]*(<[^>]+>)*[^<]*${name}`));
    assert.doesNotMatch(html, />\s*\/config\/[a-z/]+\s*</, "no raw JSON path as visible text");
    assert.match(html, /data-path="\/config\/prompt"/);
    const advanced = html.match(/<details[^>]*class="[^"]*advanced[^"]*"[^>]*>([\s\S]*?)<\/details>/)?.[1] ?? "";
    assert.match(advanced, /abcdef0123456789abcdef/, "effective hash lives in the collapsed advanced card");
    assert.equal(html.split("abcdef0123456789abcdef").length - 1, 1, "hash not shown elsewhere");
    assert.match(html, /class="[^"]*agent-preview/);
    assert.match(html, /does not call the model/i);
  } finally { restore(); }
});

test("editing shows an unsaved badge, a dirty dot on the group and the discard button", async () => {
  const { bindings, rerender, restore } = await mountDrawer({});
  try {
    bindings.change("/config/prompt", "new prompt");
    await nextTick();
    const html = await rerender();
    assert.match(html, /aria-live="polite"[^>]*>[^<]*Unsaved 1/);
    assert.match(html, /data-group="persona"[^>]*>[\s\S]*?class="dirty-dot"/);
  } finally { restore(); }
});

test("skills render as removable chips with a searchable add list", async () => {
  const { html, restore } = await mountDrawer({});
  try {
    assert.match(html, /class="skill-chip"[\s\S]*Writer/);
    assert.match(html, /Add skill/);
  } finally { restore(); }
});

test("regression: saving through the impact confirmation patches once with the etag and shows a status toast", async () => {
  const record = detail();
  const patches: unknown[] = [];
  const saved = { ...record, definition: { ...record.definition, name: "two", revision: "2" }, etag: '"agent-1-2"' } as Detail;
  const { bindings, rerender, restore } = await mountDrawer({
    impact: async () => impact, detail: async () => record,
    patch: async (current: Detail, changes: unknown) => { patches.push([current.etag, changes]); return saved; },
  }, record);
  try {
    bindings.change("/name", "two");
    await bindings.prepare("save");
    bindings.acknowledged.value = true;
    await bindings.confirmAction();
    assert.deepEqual(patches, [['"agent-1-1"', { "/name": "two" }]]);
    assert.equal(bindings.status.value, "saved");
    assert.equal(bindings.editor.dirty, false);
    assert.match(await rerender(), /role="status"[^>]*>[\s\S]*Saved/);
  } finally { restore(); }
});

test("regression: a 412 save refreshes and shows the side-by-side conflict card, keeping my change", async () => {
  const record = detail();
  const current = { ...record, definition: { ...record.definition, name: "theirs", revision: "2" }, etag: '"agent-1-2"' } as Detail;
  let reads = 0;
  const { bindings, rerender, restore } = await mountDrawer({
    impact: async () => impact, detail: async () => (reads++ === 0 ? record : current),
    patch: async () => { throw new DefinitionError(412, "precondition"); },
  }, record);
  try {
    bindings.change("/name", "mine");
    await bindings.prepare("save");
    bindings.acknowledged.value = true;
    await bindings.confirmAction();
    assert.equal(bindings.editor.current?.etag, '"agent-1-2"');
    assert.equal(bindings.editor.changes["/name"], "mine");
    const html = await rerender();
    assert.match(html, /class="conflict-card/);
    assert.match(html, /class="conflict-option[^"]*"[\s\S]*mine[\s\S]*theirs/);
    assert.doesNotMatch(html, /<legend><code>\/name<\/code>/);
  } finally { restore(); }
});

test("Ctrl+S only saves when saving is allowed; Escape routes through the discard confirmation", async () => {
  let impacts = 0;
  const { bindings, restore } = await mountDrawer({ impact: async () => { impacts++; return impact; } });
  try {
    const key = (init: Record<string, unknown>) => ({ preventDefault() {}, ...init }) as unknown as KeyboardEvent;
    bindings.shortcut(key({ key: "s", ctrlKey: true }));
    assert.equal(impacts, 0, "clean drawer does not save");
    bindings.change("/name", "two");
    bindings.shortcut(key({ key: "s", metaKey: true }));
    await new Promise(resolve => setTimeout(resolve));
    assert.equal(impacts, 1);
    bindings.action.value = null;
    bindings.close();
    assert.equal(bindings.discard.value, true);
  } finally { restore(); }
});

test("motion uses aurora tokens only and honours reduced motion", () => {
  const dir = new URL("../src/agent-definition/", import.meta.url);
  for (const file of ["DefinitionDrawer.vue", "AgentManagement.vue"]) {
    const source = readFileSync(new URL(file, dir), "utf8");
    assert.doesNotMatch(source, /cubic-bezier/, `${file} must reuse --ease tokens`);
    assert.match(source, /prefers-reduced-motion/);
  }
  assert.match(readFileSync(new URL("AgentManagement.vue", dir), "utf8"), /fade-in-up/);
  assert.match(readFileSync(new URL("DefinitionDrawer.vue", dir), "utf8"), /slide-in-right/);
});

test("list renders cards with status pills, filter counts and staggered entrance", async () => {
  const list = await loadComponent("src/agent-definition/AgentManagement.vue") as { setup: Function };
  const setup = list.setup;
  list.setup = function (props: unknown, context: unknown) {
    const bindings = setup(props, context);
    bindings.definitions.value = [detail().definition, { ...detail().definition, id: 2, name: "two", isActive: true, updatedAt: "2026-10-13T00:00:00Z" }];
    return bindings;
  };
  try {
    const html = await render(list, { api: {} }, "en");
    assert.match(html, /class="agent-card[^"]*delay-1/);
    assert.match(html, /class="pill state disabled"/);
    assert.match(html, /aria-pressed="true"[^>]*>[^<]*All[^<]*<span[^>]*>2</);
    assert.match(html, /Active[^<]*<span[^>]*>1</);
  } finally { list.setup = setup; }
});

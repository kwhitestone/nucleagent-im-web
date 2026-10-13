import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createRenderer, h, nextTick, reactive, ssrContextKey, type Component, type ComponentInternalInstance } from "vue";
import { createI18n } from "vue-i18n";
import { createServer, type ViteDevServer } from "vite";
import vue from "@vitejs/plugin-vue";
import { DefinitionEditor } from "../src/agent-definition/state.ts";
import type { Detail } from "../src/agent-definition/api.ts";

// E2E-11 regression: polling / focus refreshes re-read the same revision as a new
// object. That must not erase the user's conflict choice or disable Apply.
let vite: ViteDevServer;
let comparison: Component;
let drawer: Component;
before(async () => {
  vite = await createServer({ configFile: false, envFile: false, plugins: [vue()], appType: "custom",
    optimizeDeps: { noDiscovery: true, entries: [] }, server: { middlewareMode: true, hmr: false, ws: false, watch: null } });
  const { default: loaded } = await vite.ssrLoadModule("/src/agent-definition/ConflictComparison.vue");
  // Real setup, computed values and watchers; only rendering is replaced (no DOM needed).
  comparison = { ...loaded, render: () => null };
  const { default: loadedDrawer } = await vite.ssrLoadModule("/src/agent-definition/DefinitionDrawer.vue");
  drawer = { ...loadedDrawer, render: () => null };
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { activeElement: null } });
});
after(async () => {
  await vite.close();
  Reflect.deleteProperty(globalThis, "window"); Reflect.deleteProperty(globalThis, "document");
});

const renderer = createRenderer<object, object>({
  patchProp() {}, insert() {}, remove() {}, setText() {}, setElementText() {},
  createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
  parentNode: () => null, nextSibling: () => null,
});
function record(revision: string, name: string, skillBindings: Detail["skillBindings"] = []): Detail {
  return {
    definition: { id: 1, name, slug: "one", revision, isActive: false, config: {} },
    capabilities: { read: true, write: true, writeIdentity: true, delete: true, restore: true, readSkills: true, writeSkillBindings: true, readTools: true, writeTools: true },
    fieldPolicy: { editablePaths: ["/name"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
    skills: [], tools: [], skillBindings, identity: { uid: 8, status: "ready" },
    effective: { revision: `effective-${revision}`, definitionRevision: revision }, etag: `"agent-1-${revision}"`,
  } as Detail;
}
// Same binding as DefinitionDrawer.vue's <ConflictComparison> usage.
function mount(editor: DefinitionEditor) {
  let instance: ComponentInternalInstance | null = null;
  const app = renderer.createApp({ render: () => editor.current && h(comparison, {
    baseline: editor.record!.definition, changes: editor.changes, current: editor.current.definition,
    onVnodeMounted: (vnode: { component: ComponentInternalInstance | null }) => { instance = vnode.component; },
  }) });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.provide(ssrContextKey, {});
  app.mount({});
  const state = () => instance!.setupState as { choices: Record<string, string>; resolved: boolean };
  return { app, state };
}
function conflicted() {
  const editor = reactive(new DefinitionEditor()) as DefinitionEditor;
  editor.open(record("1", "original")); editor.change("/name", "mine");
  editor.acceptRefresh(record("2", "theirs"));
  assert.equal(editor.error, "conflict");
  return editor;
}

test("same-revision refresh keeps the conflict choice and Apply enabled", async () => {
  const editor = conflicted();
  const { app, state } = mount(editor);
  try {
    assert.equal(state().resolved, false);
    state().choices["/name"] = "mine";
    await nextTick();
    assert.equal(state().resolved, true);
    for (let i = 0; i < 3; i++) { // poll + focus + visibilitychange re-reads
      editor.acceptRefresh(record("2", "theirs"));
      await nextTick();
      assert.equal(state().choices["/name"], "mine", "same revision re-read must keep the choice");
      assert.equal(state().resolved, true, "Apply must stay enabled");
    }
    editor.resolve({ ...state().choices } as Record<string, "mine" | "current">);
    assert.equal(editor.current, null);
    assert.equal(editor.changes["/name"], "mine");
  } finally { app.unmount(); }
});

test("real content change still clears the choice; older revision is still ignored", async () => {
  const editor = conflicted();
  const { app, state } = mount(editor);
  try {
    state().choices["/name"] = "current";
    editor.acceptRefresh(record("3", "theirs"));
    await nextTick();
    assert.equal(editor.current?.definition.revision, "3");
    assert.equal(state().choices["/name"], undefined, "revision advance must clear choices");
    assert.equal(state().resolved, false);

    state().choices["/name"] = "mine";
    editor.acceptRefresh(record("2", "stale"));
    await nextTick();
    assert.equal(editor.current?.definition.revision, "3", "older revision still dropped");
    assert.equal(state().choices["/name"], "mine");

    editor.acceptRefresh(record("3", "theirs-again"));
    await nextTick();
    assert.equal(state().choices["/name"], undefined, "changed conflicting value must clear choices");
    assert.equal(state().resolved, false);
  } finally { app.unmount(); }
});

test("same-revision refresh keeps the skill-binding conflict resolvable", () => {
  const editor = reactive(new DefinitionEditor()) as DefinitionEditor;
  editor.open(record("1", "original")); editor.change("/name", "mine");
  editor.bindings = [{ skillId: 1, installPath: "" }];
  const theirs = [{ skillId: 2, installPath: "" }];
  editor.acceptRefresh(record("2", "theirs", theirs));
  assert.equal(editor.bindingConflict, true);
  editor.acceptRefresh(record("2", "theirs", [...theirs]));
  assert.equal(editor.bindingConflict, true, "binding conflict panel stays rendered");
  editor.resolve({ "/name": "mine" }, "mine");
  assert.deepEqual(editor.bindings, [{ skillId: 1, installPath: "" }]);
});

// Drives DefinitionDrawer's real `watch(() => props.detail, acceptRefresh)` path, as the
// 2s poll / focus refresh in AgentManagement does, and checks the skill-binding choice.
test("drawer: same-revision detail refresh keeps the skill-binding choice", async () => {
  const theirs = [{ skillId: 2, installPath: "" }];
  const props = reactive({ detail: record("1", "original"),
    api: { models: async () => [], backends: async () => [] } as unknown });
  let instance: ComponentInternalInstance | null = null;
  const app = renderer.createApp({ render: () => h(drawer, { ...props,
    onVnodeMounted: (vnode: { component: ComponentInternalInstance | null }) => { instance = vnode.component; } }) });
  app.use(createI18n({ legacy: false, locale: "en", messages: { en: {} } }));
  app.provide(ssrContextKey, {});
  app.mount({});
  try {
    const state = instance!.setupState as { editor: DefinitionEditor; bindingChoice: string | undefined };
    state.editor.change("/name", "mine");
    state.editor.bindings = [{ skillId: 1, installPath: "" }];
    props.detail = record("2", "theirs", theirs);
    await nextTick();
    assert.equal(state.editor.error, "conflict");
    assert.equal(state.editor.bindingConflict, true);
    state.bindingChoice = "mine";
    props.detail = record("2", "theirs", [...theirs]);
    await nextTick();
    assert.equal(state.bindingChoice, "mine", "same revision re-read must keep the binding choice");
    assert.equal(state.editor.bindingConflict, true);
    assert.equal(state.editor.current?.definition.revision, "2");
  } finally { app.unmount(); }
});

// Review (M07): when the conflict changes, ALL choices must be cleared, including those of
// rows that are no longer conflicting. A stale "current" would make rebaseChanges silently
// drop the user's edit on that row.
test("conflict change clears choices of rows that stopped conflicting (no silent edit loss)", async () => {
  const at = (revision: string, name: string, slug: string) => {
    const detail = record(revision, name);
    detail.definition.slug = slug;
    detail.fieldPolicy.editablePaths = ["/name", "/slug"];
    return detail;
  };
  const editor = reactive(new DefinitionEditor()) as DefinitionEditor;
  editor.open(at("1", "original", "one"));
  editor.change("/name", "mine"); editor.change("/slug", "slug-mine");
  editor.acceptRefresh(at("2", "theirs", "slug-theirs"));
  const { app, state } = mount(editor);
  try {
    state().choices["/name"] = "mine"; state().choices["/slug"] = "current";
    await nextTick();
    editor.acceptRefresh(at("3", "theirs", "one")); // /slug reverted upstream: no longer conflicting
    await nextTick();
    assert.equal(state().choices["/slug"], undefined, "stale choice on a no-longer-conflicting row must be cleared");
    assert.equal(state().resolved, false);
    state().choices["/name"] = "mine";
    await nextTick();
    assert.equal(state().resolved, true);
    editor.resolve({ ...state().choices } as Record<string, "mine" | "current">);
    assert.equal(editor.changes["/slug"], "slug-mine", "user's /slug edit must survive");
    assert.equal(editor.changes["/name"], "mine");
  } finally { app.unmount(); }
});

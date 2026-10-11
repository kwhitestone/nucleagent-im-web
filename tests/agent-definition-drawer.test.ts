import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { loadComponent, render } from "./render.ts";
import { DefinitionError, type Detail } from "../src/agent-definition/api.ts";
import { nextTick } from "vue";

test("tool property selector follows the actual policy keywords after a refresh", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { activeElement: null } as unknown as Document;
  const tool = await loadComponent("src/agent-definition/ToolEditor.vue") as { setup: Function };
  const setup = tool.setup;
  let bindings: any;
  tool.setup = function (props: unknown, context: unknown) { bindings = setup(props, context); return bindings; };
  const record = { tool: { id: 1 }, etag: '"tool-1-1"', capabilities: { read: true, write: true },
    fieldPolicy: { editablePaths: [], protectedPaths: [], readOnlyPaths: [], unknownPaths: [], reasons: {},
      schemaPropertyRules: [{ parentPath: "/schema", keywords: ["description"] }] } };
  try {
    await render(tool, { api: {}, id: 1 });
    bindings.accept(record);
    await nextTick();
    assert.equal(bindings.propertyKeyword.value, "description");
    bindings.propertyRule.value = 9;
    bindings.accept({ ...record, etag: '"tool-1-2"' });
    await nextTick();
    assert.equal(bindings.propertyRule.value, 0);
    assert.equal(bindings.propertyKeyword.value, "description");
  } finally { tool.setup = setup; globalThis.document = originalDocument; }
});

test("IM management owns a viewport-height scroll container", () => {
  const app = readFileSync(new URL("../src/App.vue", import.meta.url), "utf8");
  const style = app.match(/\.agent-management-page\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(style, /height:\s*100dvh/);
  assert.match(style, /overflow-y:\s*auto/);
  assert.match(style, /min-width:\s*0/);
});

test("lifecycle confirmation erases private fields when its authoritative detail read is forbidden", async () => {
  const originalDocument = globalThis.document;
  globalThis.document = { activeElement: null } as unknown as Document;
  const drawer = await loadComponent("src/agent-definition/DefinitionDrawer.vue") as { setup: Function };
  const setup = drawer.setup;
  let bindings: any;
  drawer.setup = function (props: unknown, context: unknown) {
    bindings = setup(props, context);
    return bindings;
  };
  const detail = {
    definition: { id: 1, name: "one", slug: "one", revision: "1", config: { prompt: "private" }, isActive: false },
    capabilities: { read: true, write: true, writeIdentity: true },
    fieldPolicy: { editablePaths: [], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
    identity: { uid: 7, status: "ready" }, effective: { revision: "one", definitionRevision: "1" },
    skills: [], skillBindings: [], tools: [], etag: '"agent-1-1"',
  } as Detail;
  const impact = { instances: 0, conversations: 0, conversations_7d: 0, skill_bindings: 0,
    im_groups: null, deliverables: null, unavailable: [], counted_at: "now" };
  let writes = 0;
  try {
    await render(drawer, { detail, api: {
      impact: async () => impact,
      detail: async () => { throw new DefinitionError(403, "forbidden"); },
      lifecycle: async () => { writes++; return detail; },
    } });
    bindings.action.value = "enable";
    bindings.impact.value = impact;
    bindings.acknowledged.value = true;
    await bindings.confirmAction();
    assert.equal(bindings.editor.record, null);
    assert.equal(bindings.action.value, null);
    assert.equal(writes, 0);
  } finally {
    drawer.setup = setup;
    globalThis.document = originalDocument;
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent, render } from "./render.ts";
import { createDefinitionApi, DefinitionError, type Detail } from "../src/agent-definition/api.ts";
import { DefinitionEditor } from "../src/agent-definition/state.ts";
import { text } from "../src/agent-definition/messages.ts";

// Catalog v2 (core 4634511): imported tools carry status/reason; anything but "ready" is listed, not pickable.
const held = { id: 5, name: "Held tool", status: "unavailable", reason: "held" };
const ready = { id: 6, name: "Ready tool", status: "ready" };
const legacy = { id: 7, name: "Old core tool" }; // older core: no status = ready

async function mountBindings(rows: unknown[], selected: number[] = []) {
  const component = await loadComponent("src/agent-definition/ToolBindings.vue") as { setup: Function };
  const setup = component.setup;
  let bindings: any;
  component.setup = function (p: unknown, c: unknown) { bindings = setup(p, c); bindings.rows.value = rows; return bindings; };
  try {
    const html = await render(component, { selected, skillIds: [], editable: true, manageable: false, fetchPage: async () => ({}) }, "zh");
    return { html, bindings };
  } finally { component.setup = setup; }
}

test("a held catalog tool is listed with its reason but cannot be ticked; ready and status-less rows stay pickable", async () => {
  const { html, bindings } = await mountBindings([held, ready, legacy]);
  assert.deepEqual(bindings.visible.value.map((row: { missing: boolean }) => row.missing), [true, false, false]);
  assert.match(bindings.visible.value[0].name, /同步暂停/);
  const boxes = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map(m => m[0]).slice(1); // [0] = selected-only toggle
  assert.equal(boxes.length, 3);
  assert.match(boxes[0], /disabled/);
  assert.doesNotMatch(boxes[1], /disabled/);
  assert.doesNotMatch(boxes[2], /disabled/);
});

test("an already-bound tool that became held can still be unticked", async () => {
  const { html } = await mountBindings([held], [5]);
  const box = [...html.matchAll(/<input type="checkbox"[^>]*>/g)].map(m => m[0])[1];
  assert.match(box, /checked/);
  assert.doesNotMatch(box, /disabled/);
});

test("tool page keeps status/reason and rejects a non-string status", async () => {
  const page = (data: unknown[]) => createDefinitionApi(async () => ({ status: 200, headers: {}, body: {
    code: 0, data, total: data.length, page: 1, pageSize: 20, hasMore: false } })).toolsPage({ page: 1, pageSize: 20, search: "" });
  assert.deepEqual((await page([held])).data[0], held);
  await assert.rejects(page([{ ...held, status: 1 }]), /Invalid tool page/);
});

test("a refused save shows the backend reason, not the generic failure", async () => {
  const record = {
    definition: { id: 1, name: "one", slug: "one", revision: "1", config: {}, isActive: false },
    capabilities: { read: true, write: true, readSkills: true, writeSkillBindings: true, readTools: true, writeTools: false, writeIdentity: true, delete: true, restore: false, writeToolBindings: true },
    fieldPolicy: { editablePaths: ["/name"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
    skills: [], skillBindings: [], toolBindings: [], effective: { revision: "e", definitionRevision: "1" }, identity: { uid: 7, status: "ready" }, etag: '"agent-1-1"',
  } as unknown as Detail;
  const editor = new DefinitionEditor();
  editor.open(record);
  editor.tools = [5];
  const saved = await editor.save({ patch: async () => { throw new DefinitionError(422, "invalid_definition_patch"); } } as never);
  assert.equal(saved, null);
  assert.equal(editor.verificationRequired, false);
  assert.equal(text(editor.error as never, "zh"), "填写的内容不符合要求，请检查后再保存。");
});

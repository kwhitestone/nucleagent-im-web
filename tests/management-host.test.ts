import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { parse, compileTemplate } from "vue/compiler-sfc";
import { createRenderer, h, nextTick } from "vue";
import { loadComponent } from "./render.ts";

test("actual App template keeps the chat branch independent from management visibility", () => {
  const source = readFileSync("src/App.vue", "utf8");
  const { descriptor } = parse(source);
  const compiled = compileTemplate({ source: descriptor.template!.content, filename: "App.vue", id: "host" });
  assert.deepEqual(compiled.errors, []);
  assert.doesNotMatch(compiled.code, /managementOpen[\s\S]{0,160}agent-management-page/);
  assert.match(source, /<AgentManagementOverlay\s+v-if="session && canManageAgents && managementOpen"/);
  assert.match(source, /<main v-else class="app-shell"/);
});

test("overlay close and Escape cannot bypass an open child editor", async () => {
  const originalDocument = globalThis.document;
  let restored = 0, closed = 0, childOpen = false;
  globalThis.document = { activeElement: { focus: () => restored++ } } as unknown as Document;
  const component = await loadComponent("src/agent-definition/AgentManagementOverlay.vue") as any;
  let state: any;
  const setup = component.setup;
  component.setup = (props: unknown, context: unknown) => { state = setup(props, context); return state; };
  component.render = () => null;
  const renderer = createRenderer<any, any>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  });
  const app = renderer.createApp({ render: () => h(component, { label: "Synthetic agents", onClose: () => closed++ }) });
  try {
    app.mount({});
    state.dialog.value = { close() {},
      querySelector: () => childOpen ? {} : null };
    await nextTick();
    state.requestClose(); assert.equal(closed, 1);
    childOpen = true;
    state.requestClose(); assert.equal(closed, 1);
    childOpen = false;
    state.requestClose(); assert.equal(closed, 2);
  } finally { app.unmount(); globalThis.document = originalDocument; }
  assert.equal(restored, 1);
});

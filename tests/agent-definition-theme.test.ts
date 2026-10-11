import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("definition surfaces include a local accessible dark theme", () => {
  const directory = new URL("../src/agent-definition/", import.meta.url);
  for (const file of ["AgentManagement.vue", "DefinitionDrawer.vue", "CreateDefinition.vue", "ToolEditor.vue", "AgentEffective.vue"]) {
    assert.match(readFileSync(new URL(file, directory), "utf8"), /<style scoped src="\.\/theme\.css"><\/style>/);
  }
  const css = readFileSync(new URL("theme.css", directory), "utf8");
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /color-scheme:\s*dark/);
  assert.match(css, /--bg-card:\s*Canvas/);
  assert.match(css, /--text-primary:\s*CanvasText/);
  assert.doesNotMatch(css, /:root|\bbody\b/);
});

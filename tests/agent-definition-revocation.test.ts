import assert from "node:assert/strict";
import { test } from "node:test";
import { DefinitionEditor } from "../src/agent-definition/state.ts";
import { DefinitionError, type DefinitionApi, type Detail } from "../src/agent-definition/api.ts";

const record = (revision = "1", allowed = true): Detail => ({
  definition: { id: 1, name: "original", slug: "one", revision, isActive: false, config: {} },
  capabilities: { read: true, write: true, writeIdentity: true, delete: true, restore: true, readTools: allowed, writeTools: allowed,
    writeToolBindings: allowed, readSkills: true, writeSkillBindings: true },
  fieldPolicy: { editablePaths: ["/name"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
  skills: [], skillBindings: [], tools: allowed ? [] : undefined, toolBindings: allowed ? [3] : [],
  identity: { uid: 8, status: "ready" },
  effective: { revision: `effective-${revision}`, definitionRevision: revision }, etag: `"agent-1-${revision}"`,
});
const api = (methods: Partial<DefinitionApi>) => methods as DefinitionApi;
for (const refresh of ["own", "revoked", "competitor"] as const) {
  test(`successful save after ${refresh} event only accepts identical authority and content`, async () => {
    const editor = new DefinitionEditor();
    editor.open(record());
    editor.change("/name", "mine");
    let finish!: (value: Detail) => void;
    const pending = editor.save(api({ patch: () => new Promise(resolve => { finish = resolve; }) }));
    const saved = record("2");
    saved.definition.name = "mine";
    const event = structuredClone(saved);
    if (refresh === "revoked") event.capabilities.readTools = false;
    if (refresh === "competitor") event.definition.name = "theirs";
    editor.acceptRefresh(event);
    finish(saved);
    const result = await pending;
    assert.equal(!!result, refresh === "own");
    assert.equal(editor.verificationRequired, refresh !== "own");
    if (refresh === "own") {
      assert.equal(editor.dirty, false);
      assert.equal(editor.current, null);
      assert.equal(editor.error, "");
    } else {
      assert.equal(editor.changes["/name"], "mine");
      assert.equal(editor.current?.definition.name, event.definition.name);
      assert.equal(editor.record?.capabilities.readTools, refresh !== "revoked");
    }
  });
}
function start(dirtyName = false) {
  const editor = new DefinitionEditor();
  editor.open({ ...record(), toolBindings: [1] });
  editor.tools = [2, 47];
  if (dirtyName) editor.change("/name", "mine");
  return editor;
}
function denied(editor: DefinitionEditor) {
  assert.equal(editor.record?.capabilities.readTools, false);
  assert.deepEqual(editor.record?.toolBindings, []);
  assert.equal(editor.record?.tools, undefined);
  assert.equal(editor.tools, undefined);
}

for (const choice of ["mine", "current"] as const) {
  for (const dirtyName of [false, true]) {
    test(`conflict revocation: ${choice}, unrelated draft=${dirtyName}`, () => {
      const editor = start(dirtyName);
      editor.acceptRefresh(record("2"));
      assert.equal(editor.toolConflict, true);
      editor.acceptRefresh(record("2", false));
      if (!dirtyName) {
        assert.equal(editor.current, null);
        assert.equal(editor.error, "");
      }
      editor.resolve({ "/name": "mine" }, undefined, choice);
      denied(editor);
      assert.equal(editor.changes["/name"], dirtyName ? "mine" : undefined);
      assert.equal(editor.record?.etag, '"agent-1-2"');
    });
  }
  test(`authorized conflict preserves cross-page selection: ${choice}`, async () => {
    const editor = start();
    editor.acceptRefresh(record("2"));
    assert.throws(() => editor.resolve({}), /tool binding choice/);
    editor.resolve({}, undefined, choice);
    assert.equal(editor.record?.capabilities.readTools, true);
    assert.deepEqual(editor.tools, choice === "mine" ? [2, 47] : undefined);
    assert.deepEqual(editor.record?.toolBindings, [3]);
    if (choice === "mine") await editor.save(api({ patch: async (baseline, _changes, _skills, tools) => {
      assert.equal(baseline.etag, '"agent-1-2"');
      assert.deepEqual(tools, [2, 47]);
      return record("3");
    } }));
  });
}
test("binding-write-only revocation retains readable server IDs, not pending IDs", () => {
  const editor = start(true);
  editor.acceptRefresh(record("2"));
  const fresh = record("2");
  fresh.capabilities.writeToolBindings = false;
  editor.acceptRefresh(fresh);
  editor.resolve({ "/name": "mine" }, undefined, "mine");
  assert.equal(editor.tools, undefined);
  assert.equal(editor.record?.capabilities.readTools, true);
  assert.deepEqual(editor.record?.toolBindings, [3]);
});
test("resolve reads latest authority even when comparison snapshot is stale", () => {
  const editor = start(true);
  editor.acceptRefresh(record("2"));
  editor.record = { ...editor.record!, capabilities: record("2", false).capabilities,
    fieldPolicy: { ...record().fieldPolicy, editablePaths: [] }, toolBindings: [], tools: undefined };
  editor.resolve({ "/name": "mine" }, undefined, "mine");
  denied(editor);
  assert.deepEqual(editor.record?.fieldPolicy.editablePaths, []);
});
for (const outcome of ["success", "412", "offline"] as const) {
  test(`old save ${outcome} cannot restore tools after refresh`, async () => {
    const editor = start();
    let finish!: () => void;
    let reads = 0;
    const pending = editor.save(api({
      patch: () => new Promise((resolve, reject) => { finish = () => outcome === "success"
        ? resolve(record("3")) : reject(outcome === "412" ? new DefinitionError(412, "conflict") : new Error("offline")); }),
      detail: async () => { reads++; return record("3"); },
    }));
    editor.acceptRefresh(record("2", false));
    finish(); await pending;
    editor.resolve({}, undefined, "mine");
    denied(editor);
    assert.equal(reads, 0);
    assert.equal(editor.verificationRequired, outcome !== "412");
    assert.equal(editor.busy, false);
  });
}
for (const reset of ["refresh", "subject", "cancel"] as const) {
  test(`old 412 reread rejected after ${reset}`, async () => {
    const editor = start();
    let finish!: (value: Detail) => void;
    const pending = editor.save(api({
      patch: async () => { throw new DefinitionError(412, "conflict"); },
      detail: () => new Promise(resolve => { finish = resolve; }),
    }));
    await Promise.resolve();
    if (reset === "refresh") editor.acceptRefresh(record("2", false));
    else {
      editor.clear();
      if (reset === "subject") editor.open({ ...record("2", false), identity: { uid: 99, status: "ready" } });
    }
    finish(record("3")); await pending;
    editor.resolve({}, undefined, "mine");
    if (reset === "cancel") assert.equal(editor.record, null);
    else denied(editor);
    if (reset === "subject") assert.equal(editor.record?.identity.uid, 99);
    assert.equal(editor.current, null);
  });
}

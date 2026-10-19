import assert from "node:assert/strict";
import { test } from "node:test";
import { DefinitionEditor, sameImpact } from "../src/agent-definition/state.ts";
import { DefinitionError, type DefinitionApi, type Detail } from "../src/agent-definition/api.ts";

function record(revision = "1", name = "original"): Detail {
  return {
    definition: { id: 1, name, slug: "one", revision, isActive: false, config: {} },
    capabilities: { read: true, write: true, writeIdentity: true, delete: true, restore: true, readSkills: true, writeSkillBindings: true, readTools: true, writeTools: true },
    fieldPolicy: { editablePaths: ["/name"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
    skills: [], tools: [], skillBindings: [], identity: { uid: 8, status: "ready" },
    effective: { revision: `effective-${revision}`, definitionRevision: revision }, etag: `"agent-1-${revision}"`,
  };
}
const api = (methods: Partial<DefinitionApi>) => methods as DefinitionApi;
test("failed save retains baseline and draft", async () => {
  const editor = new DefinitionEditor();
  editor.open(record()); editor.change("/name", "mine");
  await editor.save(api({ patch: async () => { throw new Error("offline"); } }));
  assert.equal(editor.changes["/name"], "mine");
  assert.equal(editor.record?.definition.name, "original");
  assert.equal(editor.error, "uncertain");
  let retried = false;
  await editor.save(api({ patch: async () => { retried = true; return record("2"); } }));
  assert.equal(retried, false, "indeterminate saves cannot be blindly retried");
  editor.acceptRefresh(record());
  assert.equal(editor.verificationRequired, false);
});
test("412 rereads current but does not discard draft or silently rebase", async () => {
  const editor = new DefinitionEditor();
  editor.open(record()); editor.change("/name", "mine");
  await editor.save(api({
    patch: async () => { throw new DefinitionError(412, "agent_definition_version_conflict"); },
    detail: async () => record("2", "theirs"),
  }));
  assert.equal(editor.current?.definition.name, "theirs");
  assert.equal(editor.record?.definition.revision, "1");
  assert.equal(editor.changes["/name"], "mine");
  assert.throws(() => editor.resolve({}), /choice/i);
  editor.resolve({ "/name": "mine" });
  assert.equal(editor.record?.etag, '"agent-1-2"');
  assert.equal(editor.changes["/name"], "mine");
});
test("permission loss blocks further writes and retains memory-only draft", async () => {
  const editor = new DefinitionEditor();
  editor.open(record()); editor.change("/name", "mine");
  await editor.save(api({ patch: async () => { throw new DefinitionError(403, "forbidden"); } }));
  assert.equal(editor.denied, true);
  assert.equal(editor.changes["/name"], "mine");
  let count = 0;
  await editor.save(api({ patch: async () => { count++; return record("2"); } }));
  assert.equal(count, 0);
});
test("older refresh ignored; fresh event preserves a dirty form", () => {
  const editor = new DefinitionEditor();
  editor.open(record("4")); editor.change("/name", "mine");
  editor.acceptRefresh(record("3", "old"));
  assert.equal(editor.current, null);
  editor.acceptRefresh(record("5", "changed"));
  assert.equal(editor.current?.definition.revision, "5");
  assert.equal(editor.record?.definition.revision, "4");
});
test("dependency effective revision invalidates even without definition revision change", () => {
  const editor = new DefinitionEditor(); editor.open(record());
  editor.acceptRefresh({ ...record(), effective: { revision: "resource-changed", definitionRevision: "1" } });
  assert.equal(editor.record?.effective.revision, "resource-changed");
});
test("late save response cannot overwrite a newly opened definition", async () => {
  const editor = new DefinitionEditor(); editor.open(record()); editor.change("/name", "mine");
  let finish!: (value: Detail) => void;
  const pending = editor.save(api({ patch: () => new Promise(resolve => { finish = resolve; }) }));
  editor.open({ ...record(), definition: { ...record().definition, id: 2, name: "second" } });
  finish(record("2", "saved")); await pending;
  assert.equal(editor.record?.definition.id, 2);
});
test("reverting edits clears dirty state and binding conflict requires explicit choice", () => {
  const editor = new DefinitionEditor(); editor.open(record());
  editor.change("/name", "mine"); editor.change("/name", "original");
  assert.equal(editor.dirty, false);
  editor.bindings = [{ skillId: 1, installPath: "" }];
  editor.acceptRefresh({ ...record("2"), skillBindings: [{ skillId: 2, installPath: "" }] });
  assert.throws(() => editor.resolve({}), /binding/i);
  editor.resolve({}, "current");
  assert.equal(editor.dirty, false);
});
test("impact confirmation compares all counts and unknowns, not timestamp", () => {
  const impact = { instances: 1, conversations: 2, conversations_7d: 1, skill_bindings: 0,
    im_groups: null, deliverables: null, unavailable: ["im_groups", "deliverables"], counted_at: "one" };
  assert.equal(sameImpact(impact, { ...impact, counted_at: "two" }), true);
  assert.equal(sameImpact(impact, { ...impact, conversations: 3 }), false);
  assert.equal(sameImpact(impact, { ...impact, unavailable: [] }), false);
});
test("read revocation erases server data and drafts and rejects late save responses", async () => {
  const editor = new DefinitionEditor(); editor.open(record()); editor.change("/name", "mine");
  let finish!: (value: Detail) => void;
  const pending = editor.save(api({ patch: () => new Promise(resolve => { finish = resolve; }) }));
  const revoked = record();
  revoked.capabilities.read = false;
  editor.acceptRefresh(revoked);
  assert.equal(editor.record, null);
  assert.deepEqual(editor.changes, {});
  assert.equal(editor.denied, true);
  finish(record("2")); await pending;
  assert.equal(editor.record, null);
});
test("write revocation applies before conflict resolution and never permits a save", async () => {
  const editor = new DefinitionEditor(); editor.open(record()); editor.change("/name", "mine");
  const revoked = record("2", "theirs"); revoked.capabilities.write = false;
  editor.acceptRefresh(revoked);
  assert.equal(editor.record?.capabilities.write, false);
  editor.resolve({ "/name": "mine" });
  let called = false;
  await editor.save(api({ patch: async () => { called = true; return record("3"); } }));
  assert.equal(called, false);
});
test("an older read cannot replace a newer pending conflict", () => {
  const editor = new DefinitionEditor(); editor.open(record()); editor.change("/name", "mine");
  editor.acceptRefresh(record("4", "latest"));
  editor.acceptRefresh(record("3", "late"));
  assert.equal(editor.current?.definition.revision, "4");
});
test("412 followed by read denial erases protected draft and current record", async () => {
  const editor = new DefinitionEditor(); editor.open(record()); editor.change("/name", "mine");
  await editor.save(api({
    patch: async () => { throw new DefinitionError(412, "conflict"); },
    detail: async () => { throw new DefinitionError(403, "forbidden"); },
  }));
  assert.equal(editor.record, null);
  assert.equal(editor.current, null);
  assert.deepEqual(editor.changes, {});
  assert.equal(editor.error, "readDenied");
});
test("412 detail permission loss is applied before displaying the conflict", async () => {
  const editor = new DefinitionEditor(); editor.open(record()); editor.change("/name", "mine");
  const revoked = record("2"); revoked.capabilities.write = false;
  await editor.save(api({
    patch: async () => { throw new DefinitionError(412, "conflict"); },
    detail: async () => revoked,
  }));
  assert.equal(editor.record?.capabilities.write, false);
  assert.equal(editor.denied, true);
});

test("pending tool selection survives 412, requires explicit resolution and clears on cancel/revocation", async () => {
  const first = { ...record(), toolBindings: [1] };
  first.capabilities.writeToolBindings = true;
  const current = { ...first, definition: { ...first.definition, revision: "2" }, etag: '"agent-1-2"', toolBindings: [3] };
  const editor = new DefinitionEditor();
  editor.open(first); editor.tools = [2, 47];
  assert.equal(editor.dirty, true);
  await editor.save(api({
    patch: async (_record, _changes, _skills, tools) => {
      assert.deepEqual(tools, [2, 47]); throw new DefinitionError(412, "conflict");
    },
    detail: async () => current,
  }));
  assert.deepEqual(editor.tools, [2, 47]);
  assert.throws(() => editor.resolve({}), /tool binding choice/);
  editor.resolve({}, undefined, "mine");
  assert.equal(editor.record?.etag, '"agent-1-2"');
  editor.clear();
  assert.equal(editor.tools, undefined);
  assert.equal(editor.dirty, false);
  editor.open(first); editor.tools = [47];
  editor.acceptRefresh({ ...current, capabilities: { ...current.capabilities, readTools: false, writeToolBindings: false } });
  assert.equal(editor.tools, undefined);
  assert.deepEqual(editor.record?.toolBindings, []);
});

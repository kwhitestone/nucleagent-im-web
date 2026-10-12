// Deterministic ordering matrix for the native E2E-11 conflict flow:
// server outcome (success / 412 / committed-but-response-lost) x the moment the
// definition event refresh lands (before save / while PATCH in flight / after the
// response / duplicated). Each cell checks the draft survives, a real 412 is never
// swallowed, an explicit choice is offered whenever the same field changed, and no
// write is retried without the user acting.
import assert from "node:assert/strict";
import { test } from "node:test";
import { DefinitionEditor } from "../src/agent-definition/state.ts";
import { compareChanges } from "../src/agent-definition/draft.ts";
import { DefinitionError, type DefinitionApi, type Detail } from "../src/agent-definition/api.ts";

function record(revision: string, name: string): Detail {
  return {
    definition: { id: 1, name, slug: "one", revision, isActive: false, config: {} },
    capabilities: { read: true, write: true, writeIdentity: true, delete: true, restore: true, readSkills: true, writeSkillBindings: true, readTools: true, writeTools: true },
    fieldPolicy: { editablePaths: ["/name"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
    skills: [], tools: [], skillBindings: [], identity: { uid: 12, status: "ready" },
    effective: { revision: `effective-${revision}`, definitionRevision: revision }, etag: `"agent-1-${revision}"`,
  };
}
const base = () => record("2", "Frontend edited im");
const theirs = () => record("3", "Other independent editor");
const MINE = "Frontend conflict resolved";

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function choiceOffered(editor: DefinitionEditor) {
  assert.ok(editor.current, "conflict comparison must be open");
  const rows = compareChanges(editor.record!.definition, editor.changes, editor.current!.definition);
  const row = rows.find(r => r.path === "/name");
  assert.equal(row?.conflict, true, "same-field concurrent edit must require an explicit choice");
  assert.equal(row?.mine, MINE);
}

type When = "before" | "inflight" | "after" | "twice";
for (const when of ["before", "inflight", "after", "twice"] as When[]) {
  test(`412 with competitor event ${when}: draft kept, explicit choice offered, no silent retry`, async () => {
    const editor = new DefinitionEditor();
    editor.open(base()); editor.change("/name", MINE);
    if (when === "before") {
      editor.acceptRefresh(theirs());
      choiceOffered(editor);
      let patched = 0;
      assert.equal(await editor.save({ patch: async () => { patched++; return theirs(); } } as unknown as DefinitionApi), null);
      assert.equal(patched, 0, "save is blocked while a conflict is unresolved");
    } else {
      const patch = deferred<Detail>();
      let patches = 0;
      const api = { patch: () => { patches++; return patch.promise; }, detail: async () => theirs() } as unknown as DefinitionApi;
      const pending = editor.save(api);
      if (when === "inflight") editor.acceptRefresh(theirs());
      patch.reject(new DefinitionError(412, "agent_definition_version_conflict"));
      assert.equal(await pending, null);
      if (when === "after" || when === "twice") editor.acceptRefresh(theirs());
      if (when === "twice") editor.acceptRefresh(theirs());
      assert.equal(patches, 1, "412 is not retried automatically");
    }
    assert.equal(editor.error, "conflict", "412 is surfaced, never swallowed");
    assert.equal(editor.changes["/name"], MINE, "draft survives");
    assert.equal(editor.record?.definition.revision, "2", "baseline not silently rebased");
    choiceOffered(editor);
    editor.resolve({ "/name": "mine" });
    assert.equal(editor.record?.etag, '"agent-1-3"', "explicit retry targets the current ETag");
    assert.equal(editor.changes["/name"], MINE);
  });
}

test("an identical refresh keeps the open comparison so an explicit choice is not reset", async () => {
  // ConflictComparison clears its radio choices whenever `current` changes identity.
  // The 412 path rereads detail and the 2s event poll then delivers the same revision
  // again; replacing `current` with an equal record silently discarded the choice.
  const editor = new DefinitionEditor();
  editor.open(base()); editor.change("/name", MINE);
  await editor.save({ patch: async () => { throw new DefinitionError(412, "conflict"); }, detail: async () => theirs() } as unknown as DefinitionApi);
  const shown = editor.current;
  editor.acceptRefresh(theirs());
  assert.equal(editor.current, shown, "same revision must not reopen the comparison");
  const fourth = record("4", "Third writer");
  editor.acceptRefresh(fourth);
  assert.equal(editor.current?.definition.revision, "4", "a newer revision still replaces the comparison");
  const dependency = { ...fourth, effective: { revision: "effective-dependency", definitionRevision: "4" } };
  editor.acceptRefresh(dependency);
  assert.equal(editor.current?.effective.revision, "effective-dependency", "dependency change still replaces it");
});

for (const when of ["inflight", "after"] as const) {
  test(`successful save with own event ${when}: saved once, clean, no conflict left`, async () => {
    const editor = new DefinitionEditor();
    editor.open(base()); editor.change("/name", MINE);
    const patch = deferred<Detail>();
    let patches = 0;
    const pending = editor.save({ patch: () => { patches++; return patch.promise; } } as unknown as DefinitionApi);
    const own = record("3", MINE);
    if (when === "inflight") editor.acceptRefresh(own);
    patch.resolve(own);
    assert.ok(await pending);
    if (when === "after") editor.acceptRefresh(record("3", MINE));
    assert.equal(patches, 1);
    assert.equal(editor.dirty, false);
    assert.equal(editor.current, null);
    assert.equal(editor.error, "");
    assert.equal(editor.record?.definition.name, MINE);
  });
}

for (const when of ["before-query", "after-query"] as const) {
  test(`committed save with lost response, own event ${when}: draft kept, no blind retry, converges explicitly`, async () => {
    const editor = new DefinitionEditor();
    editor.open(base()); editor.change("/name", MINE);
    let patches = 0;
    await editor.save({ patch: async () => { patches++; throw new TypeError("network"); } } as unknown as DefinitionApi);
    assert.equal(editor.verificationRequired, true);
    assert.equal(editor.error, "uncertain");
    assert.equal(await editor.save({ patch: async () => { patches++; return base(); } } as unknown as DefinitionApi), null);
    assert.equal(patches, 1, "an indeterminate write is never retried blindly");
    editor.acceptRefresh(record("3", MINE));
    if (when === "after-query") editor.acceptRefresh(record("3", MINE));
    assert.equal(editor.verificationRequired, false);
    assert.equal(editor.changes["/name"], MINE, "draft is not discarded by the refresh");
    const row = compareChanges(editor.record!.definition, editor.changes, editor.current!.definition).find(r => r.path === "/name");
    assert.equal(row?.conflict, false, "own committed value is recognised, nothing to choose");
    editor.resolve({});
    assert.equal(editor.dirty, false, "resolving against the committed value leaves nothing to resend");
  });
}

import assert from "node:assert/strict";
import { test } from "node:test";
import { createEffectiveApi } from "../src/agent-definition/effective.ts";

const materials = {
  definitionRevision: "9007199254740993", identityRevision: "4", effectiveRevision: "opaque-current",
  promptSources: ["template", "instance"], modelSource: "conversation", backendSource: "instance",
  skillSource: "template", skills: [{ id: 7, revision: "3", source: "template", fingerprint: "s7" }],
  tools: [{ id: 8, revision: "5", source: "template", skillId: 7, fingerprint: "t8" }],
  bindings: [{ id: 9, skillId: 7, source: "instance", executing: false }],
};
const data = { definitionId: 4, definitionRevision: "9007199254740993", instanceId: 5, conversationId: 6,
  enabled: true, deleted: false, stale: false, current: materials,
  admitted: { ...materials, definitionRevision: "2", effectiveRevision: "opaque-admitted" } };
const ok = (value: unknown = data) => ({ status: 200, headers: {}, body: { code: 0, data: value } });

test("owner effective reads use explicit instance/conversation IDs, never admin detail", async () => {
  const calls: any[] = [];
  const api = createEffectiveApi(async (path, init) => { calls.push({ path, init }); return ok(); });
  const record = await api.conversation(6);
  await api.instance(5);
  assert.deepEqual(calls.map(c => c.path), [
    "/api/v1/addons/conversation/6/effective-definition",
    "/api/v1/addons/conversation/agent-instances/5/effective-definition",
  ]);
  assert.ok(calls.every(c => c.init.cache === "no-store"));
  assert.equal(record.current?.definitionRevision, "9007199254740993");
  assert.equal(record.current?.modelSource, "conversation");
  assert.equal(record.current?.backendSource, "instance");
  assert.deepEqual(record.current?.promptSources, ["template", "instance"]);
  assert.equal(record.current?.bindings[0].executing, false);
  assert.equal(record.admitted?.definitionRevision, "2");
});
test("unresolved or disabled definitions show unavailable current, not a fabricated version", async () => {
  const record = await createEffectiveApi(async () => ok({ ...data, enabled: false, stale: true, current: null })).conversation(6);
  assert.equal(record.current, null);
  assert.equal(record.admitted?.effectiveRevision, "opaque-admitted");
});
test("effective endpoint errors and invalid IDs fail closed", async () => {
  let calls = 0;
  const api = createEffectiveApi(async () => { calls++; return { status: 404, headers: {}, body: { code: "not_found" } }; });
  await assert.rejects(api.instance(5), /not_found/);
  await assert.rejects(api.instance(NaN), /ID/);
  await assert.rejects(api.conversation(-1), /ID/);
  assert.equal(calls, 1);
});
test("IM UID lookup is owner-scoped and uses returned Core identifiers", async () => {
  const paths: string[] = [];
  const api = createEffectiveApi(async path => { paths.push(path); return ok(); });
  const record = await api.uid(72);
  assert.deepEqual(paths, ["/api/v1/addons/conversation/agent-uid/72/effective-definition"]);
  assert.equal(record.definitionId, 4);
  assert.equal(record.instanceId, 5);
  for (const invalid of [0, -1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(api.uid(invalid), /ID/);
  }
  assert.equal(paths.length, 1);
});
test("effective projection discards unexpected config and never guesses numeric revision or sources", async () => {
  const record = await createEffectiveApi(async () => ok({ ...data, config: { prompt: "private-fixture" },
    current: { ...materials, prompt: "private-fixture" } })).conversation(6);
  assert.equal(JSON.stringify(record).includes("private-fixture"), false);
  for (const patch of [{ definitionRevision: 3 }, { modelSource: "invented" }, { promptSources: ["secret"] }]) {
    await assert.rejects(createEffectiveApi(async () => ok({ ...data, current: { ...materials, ...patch } })).conversation(6), /contract/);
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  definitionFields, buildChanges, compareChanges, rebaseChanges,
  newerRevision, reconcileBindings, validateChanges,
} from "../src/agent-definition/draft.ts";

const baseline = {
  name: "Support", slug: "support", config: {
    description: "Existing", prompt: "Original", memory: true,
    defaults: { executionBackend: "native", providerId: 7, model: "chat", future: null },
    unknown: { large: "9007199254740993", array: [null, false] },
  },
};
const editable = definitionFields.filter((f) => f.path !== "/slug").map((f) => f.path);

test("dirty PATCH sends only changed leaves, never reconstructed config", () => {
  assert.deepEqual(buildChanges(baseline, { "/name": "New", "/config/prompt": "Original" }, editable), { "/name": "New" });
  assert.equal(baseline.config.unknown.large, "9007199254740993");
});
test("unknown config, sensitive placeholders and identity cannot be written", () => {
  for (const path of ["/config", "/config/unknown", "/authAgentUserId", "/config/token", "/config/defaults/temperature", "/__proto__/polluted"]) {
    assert.throws(() => buildChanges(baseline, { [path]: "hidden" }, [...editable, path]), /read.only|unsupported/i);
  }
});
test("backend editable paths are required, slug immutable after creation", () => {
  assert.throws(() => buildChanges(baseline, { "/name": "Changed" }, []), /read.only/i);
  assert.throws(() => buildChanges(baseline, { "/slug": "renamed" }, editable), /read.only/i);
});
test("false and empty strings are changes, undefined is never serialized", () => {
  assert.deepEqual(buildChanges(baseline, { "/config/memory": false, "/config/prompt": "" }, editable),
    { "/config/memory": false, "/config/prompt": "" });
  assert.throws(() => buildChanges(baseline, { "/name": undefined }, editable), /invalid/i);
});
test("412 comparison shows baseline, draft and current values by dirty path", () => {
  const current = { ...baseline, name: "Remote" };
  assert.deepEqual(compareChanges(baseline, { "/name": "Mine", "/config/prompt": "New" }, current), [
    { path: "/name", before: "Support", mine: "Mine", current: "Remote", conflict: true },
    { path: "/config/prompt", before: "Original", mine: "New", current: "Original", conflict: false },
  ]);
});
test("rebasing requires an explicit choice for every conflicting field", () => {
  const current = { ...baseline, name: "Remote" };
  assert.throws(() => rebaseChanges(baseline, { "/name": "Mine" }, current, {}), /choice/i);
  assert.deepEqual(rebaseChanges(baseline, { "/name": "Mine" }, current, { "/name": "current" }), {});
  assert.deepEqual(rebaseChanges(baseline, { "/name": "Mine" }, current, { "/name": "mine" }), { "/name": "Mine" });
});
test("revisions compare without losing precision and reject duplicate or older events", () => {
  assert.equal(newerRevision("9007199254740993", "9007199254740992"), true);
  assert.equal(newerRevision("12", "12"), false);
  assert.equal(newerRevision("11", "12"), false);
  assert.equal(newerRevision("bad", "12"), false);
});
test("skill selection preserves existing install paths and uses server catalog paths for new bindings", () => {
  assert.deepEqual(reconcileBindings(
    [{ skillId: 1, installPath: "/existing" }],
    [1, 2],
    [{ skillId: 1, installPath: "/changed" }, { skillId: 2, installPath: "/catalog" }],
  ), [{ skillId: 1, installPath: "/existing" }, { skillId: 2, installPath: "/catalog" }]);
  assert.throws(() => reconcileBindings([], [3], []), /unavailable/i);
});
test("validation counts Unicode codepoints and preserves prompt whitespace", () => {
  assert.deepEqual(validateChanges(baseline, { "/name": "a".repeat(128), "/config/prompt": "  hi  " }), {});
  assert.equal(validateChanges(baseline, { "/name": "a".repeat(129) })["/name"], "length");
  assert.equal(validateChanges(baseline, { "/config/description": "\u{1f600}".repeat(200) })["/config/description"], undefined);
});
test("model/provider pair is validated across baseline and changed fields", () => {
  assert.equal(validateChanges(baseline, { "/config/defaults/providerId": null })["/config/defaults/model"], "modelPair");
  assert.equal(validateChanges(baseline, { "/config/defaults/providerId": -1 })["/config/defaults/providerId"], "provider");
});
test("field policy exposes complete supported fields, not invented sampling controls", () => {
  assert.deepEqual(definitionFields.map((f) => f.path), [
    "/name", "/slug", "/config/description", "/config/avatar", "/config/prompt",
    "/config/memory", "/config/defaults/executionBackend", "/config/defaults/providerId", "/config/defaults/model",
  ]);
});
test("unsafe avatar protocols and invalid slug are rejected", () => {
  assert.equal(validateChanges({}, { "/slug": "Invalid Slug" })["/slug"], "slug");
  assert.equal(validateChanges({}, { "/config/avatar": "javascript:alert(1)" })["/config/avatar"], "avatar");
});

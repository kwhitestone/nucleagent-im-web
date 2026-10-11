import assert from "node:assert/strict";
import { test } from "node:test";
import { invalidatedDefinitions } from "../src/agent-definition/events.ts";
import type { DefinitionEvent } from "../src/agent-definition/api.ts";
const event = (id: string, revision: string, definitionId = 1): DefinitionEvent => ({
  id, definitionId, revision, kind: "update", changedPaths: ["/name"],
});
test("old duplicate and reordered events never roll back a definition", () => {
  const result = invalidatedDefinitions("4", [event("6", "4"), event("5", "3"), event("4", "99")], new Map([[1, "4"]]));
  assert.deepEqual(result.ids, []);
  assert.equal(result.cursor, "6");
});
test("resource edits invalidate same definition revision; IDs are deduplicated", () => {
  const result = invalidatedDefinitions("4", [{ ...event("5", "4"), resourceType: "tool", resourceId: 2 },
    event("6", "5"), event("7", "6")], new Map([[1, "4"]]));
  assert.deepEqual(result.ids, [1]);
  assert.equal(result.cursor, "7");
});
test("events for unloaded definitions refresh the catalog; cursor never loses precision", () => {
  const result = invalidatedDefinitions("9007199254740993", [event("9007199254740994", "1", 2)], new Map());
  assert.deepEqual(result.ids, [2]); assert.equal(result.cursor, "9007199254740994");
});
test("malformed event batches fail without advancing the durable cursor", () => {
  assert.throws(() => invalidatedDefinitions("4", [event("5", "6"), event("wrong", "1")], new Map()), /event/i);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { CreationDraft } from "../src/agent-definition/creation.ts";
import { DefinitionError, type DefinitionApi, type Catalog, type Detail } from "../src/agent-definition/api.ts";

const catalog = { capabilities: { create: true }, fieldPolicy: { editablePaths: ["/name"] } } as Catalog;
const saved = { definition: { id: 3 } } as Detail;
test("uncertain creation freezes payload and retries only after result lookup with the same key", async () => {
  const draft = new CreationDraft("test_request_123456");
  draft.slug = "test"; draft.changes = { "/name": "Original" };
  const calls: string[] = [];
  const api = {
    create: async (_c: unknown, _s: string, changes: unknown, key: string) => {
      calls.push(`create:${key}`); assert.deepEqual(changes, { "/name": "Original" });
      throw new Error("lost response");
    },
    creationResult: async (key: string) => { calls.push(`lookup:${key}`); return saved; },
  } as unknown as DefinitionApi;
  assert.equal(await draft.submit(api, catalog), null);
  assert.equal(draft.uncertain, true);
  assert.equal(await draft.submit(api, catalog), null);
  assert.deepEqual(calls, ["create:test_request_123456"]);
  assert.equal(await draft.lookup(api), saved);
  assert.equal(draft.completed, true);
});
test("404 after an uncertain creation allows only exact frozen retry, validation failures keep draft editable", async () => {
  const draft = new CreationDraft("test_request_123456");
  draft.slug = "test"; draft.changes = { "/name": "Original" };
  let count = 0;
  const api = {
    create: async (_c: unknown, _s: string, changes: unknown) => {
      count++; assert.deepEqual(changes, { "/name": "Original" });
      if (count === 1) throw new Error("offline");
      return saved;
    },
    creationResult: async () => { throw new DefinitionError(404, "not_found"); },
  } as unknown as DefinitionApi;
  await draft.submit(api, catalog);
  await draft.lookup(api);
  draft.changes = { "/name": "Modified" };
  assert.equal(await draft.submit(api, catalog), saved);
});
test("an idempotency conflict stays frozen and must query the existing request", async () => {
  const draft = new CreationDraft("test_request_123456"); draft.slug = "test"; draft.changes = { "/name": "Original" };
  const api = { create: async () => { throw new DefinitionError(409, "idempotency_key_conflict"); } } as unknown as DefinitionApi;
  await draft.submit(api, catalog);
  assert.equal(draft.frozen, true);
  assert.equal(draft.uncertain, true);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefinitionApi, DefinitionError, type Transport } from "../src/agent-definition/api.ts";

const detail = {
  definition: { id: 4, name: "A", slug: "a", revision: "2", isActive: false, config: {} },
  capabilities: { read: true, write: true, writeIdentity: true, delete: true, restore: true, readSkills: false, writeSkillBindings: false, readTools: false, writeTools: false },
  fieldPolicy: { editablePaths: ["/name"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
  skillBindings: [], skills: [], tools: [],
  effective: { revision: "opaque", definitionRevision: "2" },
  identity: { uid: 5, status: "ready", projectionRevision: "2" },
};
const ok = (data: unknown = detail) => ({ status: 200, headers: { etag: '"agent-4-2"' }, body: { code: 0, data } });

test("detail reads authoritative aggregate and retains the opaque ETag", async () => {
  const calls: string[] = [];
  const api = createDefinitionApi(async path => { calls.push(path); return ok(); });
  assert.deepEqual(await api.detail(4), { ...detail, etag: '"agent-4-2"' });
  assert.deepEqual(calls, ["/api/v1/addons/admin/agents/4"]);
});
test("PATCH sends only dirty leaves and exact If-Match, no legacy DTO", async () => {
  let call: any;
  const api = createDefinitionApi(async (path, init) => { call = { path, init }; return ok(); });
  const saved = await api.patch(await api.detail(4), { "/name": "B" });
  assert.equal(saved.definition.revision, "2");
  assert.equal(call.init.headers["If-Match"], '"agent-4-2"');
  assert.deepEqual(JSON.parse(call.init.body), { changes: { "/name": "B" } });
  assert.equal(call.init.method, "PATCH");
});
test("missing ETag or malformed aggregate fails closed before it becomes editable", async () => {
  for (const response of [{ ...ok(), headers: {} }, ok({ ...detail, definition: undefined }), ok({ ...detail, fieldPolicy: undefined })]) {
    await assert.rejects(createDefinitionApi(async () => response).detail(4), /contract|ETag/i);
  }
});
test("412, 428 and 403 retain domain code and HTTP status", async () => {
  for (const status of [412, 428, 403]) {
    const api = createDefinitionApi(async () => ({ status, headers: {}, body: { status, code: "agent_definition_version_conflict" } }));
    await assert.rejects(api.detail(4), (error: unknown) => error instanceof DefinitionError
      && error.status === status && error.code === "agent_definition_version_conflict");
  }
});
test("Huma problem response exposes only its stable top-level code", async () => {
  const api = createDefinitionApi(async () => ({ status: 422, headers: {},
    body: { status: 422, title: "invalid", detail: "private diagnostic", code: "invalid_definition_patch" } }));
  await assert.rejects(api.detail(4), (error: unknown) => error instanceof DefinitionError
    && error.code === "invalid_definition_patch" && !error.message.includes("private"));
});
test("all lifecycle mutations use CAS; delete is blocked while active", async () => {
  const calls: any[] = [];
  const api = createDefinitionApi(async (path, init) => { calls.push({ path, init }); return ok(); });
  const record = await api.detail(4);
  for (const action of ["delete", "restore", "enable", "disable", "retry"] as const) {
    await api.lifecycle(record, action);
    assert.equal(calls.at(-1).init.headers["If-Match"], record.etag);
  }
  await assert.rejects(api.lifecycle({ ...record, definition: { ...record.definition, isActive: true } }, "delete"), /inactive/i);
});
test("a false write capability stops network dispatch", async () => {
  let count = 0;
  const api = createDefinitionApi(async () => { count++; return ok(); });
  const record = await api.detail(4);
  count = 0;
  await assert.rejects(api.patch({ ...record, capabilities: { ...record.capabilities, write: false } }, { "/name": "B" }), /forbidden/i);
  assert.equal(count, 0);
});
test("binding edits require their own capability and preserve omitted bindings", async () => {
  const api = createDefinitionApi(async () => ok());
  const record = await api.detail(4);
  await assert.rejects(api.patch(record, {}, []), /forbidden/i);
});
test("missing lifecycle permission fails closed without dispatch", async () => {
  let count = 0;
  const api = createDefinitionApi(async () => { count++; return ok(); });
  const record = await api.detail(4);
  record.capabilities = { ...record.capabilities };
  delete (record.capabilities as Partial<typeof record.capabilities>).delete;
  count = 0;
  await assert.rejects(api.lifecycle(record, "delete"), /forbidden/);
  assert.equal(count, 0);
});
test("typed model catalog reads top-level availability and never falls back", async () => {
  const models = [{ providerId: 3, model: "available", type: "chat" }];
  const api = createDefinitionApi(async () => ({
    status: 200, headers: {}, body: { code: 0, typesAvailable: true, data: models },
  }));
  assert.deepEqual(await api.models(), models);
  await assert.rejects(createDefinitionApi(async () => ({
    status: 200, headers: {}, body: { code: 0, typesAvailable: false, data: [] },
  })).models(), /unavailable/);
});
test("events use cursor pagination without embedding any definition text", async () => {
  let url = "";
  const api = createDefinitionApi(async path => { url = path; return ok({ events: [], nextCursor: "17", hasMore: false }); });
  await api.events("16");
  assert.equal(url, "/api/v1/addons/admin/agents/events?after=16&limit=100");
});

test("creation uses catalog policy and actor-scoped idempotency, lookup never POSTs", async () => {
  const catalog = { capabilities: { ...detail.capabilities, create: true }, fieldPolicy: detail.fieldPolicy, skills: [] };
  const calls: any[] = [];
  const api = createDefinitionApi(async (path, init) => {
    calls.push({ path, init }); return ok(path.endsWith("/catalog?includeSkills=false") ? catalog : detail);
  });
  assert.deepEqual(await api.catalog(), catalog);
  await api.create(catalog, "new-agent", { "/name": "New" }, "request_key_123456");
  assert.equal(calls.at(-1).init.headers["Idempotency-Key"], "request_key_123456");
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { slug: "new-agent", changes: { "/name": "New" } });
  await api.creationResult("request_key_123456");
  assert.match(calls.at(-1).path, /\/requests\/request_key_123456$/);
  assert.notEqual(calls.at(-1).init.method, "POST");
  await assert.rejects(api.create({ ...catalog, capabilities: { ...catalog.capabilities, create: false } }, "new", { "/name": "New" }, "request_key_123456"), /forbidden/);
  await assert.rejects(api.create(catalog, "new", { "/name": "New" }, "../invalid"), /idempotency/i);
});

test("skill selection uses paged transport, selected IDs and cancellation without catalog fallback", async () => {
  const calls: any[] = [];
  const controller = new AbortController();
  const page = { code: 0, data: [], page: 2, pageSize: 20, total: 23, hasMore: false };
  const api = createDefinitionApi(async (path, init) => {
    calls.push({ path, init }); return { status: 200, headers: {}, body: page };
  });
  assert.deepEqual(await api.skillsPage({ page: 2, pageSize: 20, search: "writer", ids: [3, 8] }, controller.signal), page);
  assert.equal(calls[0].path, "/api/v1/addons/skill?page=2&pageSize=20&search=writer&ids=3%2C8");
  assert.equal(calls[0].init.signal, controller.signal);
  page.pageSize = 101;
  await assert.rejects(api.skillsPage({ page: 1, pageSize: 20, search: "" }), /Invalid skill page/);
});

test("shared tool updates carry own CAS and only policy-approved safe dirty leaves", async () => {
  const data = { tool: { id: 7, revision: "3", name: "Tool", slug: "tool", isActive: true, config: { description: "before" } },
    capabilities: { read: true, write: true },
    fieldPolicy: { ...detail.fieldPolicy, editablePaths: ["/name", "/config/description", "/config/mcp_config/input_schema/properties/probe/type"] } };
  let sent: any;
  const api = createDefinitionApi(async (path, init) => {
    sent = { path, init }; return { ...ok(data), headers: { etag: '"tool-7-3"' } };
  });
  const resource = await api.tool(7);
  await api.patchTool(resource, { "/config/description": "after", "/config/mcp_config/input_schema/properties/probe/type": "string" });
  assert.equal(sent.path, "/api/v1/addons/tool/7");
  assert.equal(sent.init.headers["If-Match"], '"tool-7-3"');
  assert.deepEqual(JSON.parse(sent.init.body).changes, {
    "/config/description": "after", "/config/mcp_config/input_schema/properties/probe/type": "string",
  });
  await assert.rejects(api.patchTool(resource, { "/config": {} }), /unsupported|policy/i);
  await assert.rejects(api.patchTool(resource, { "/config/mcp_config/endpoint": "https://example.test" }), /unsupported|policy/i);
});

test("aggregate rejects mismatched ETag, numeric revisions and incomplete policy", async () => {
  for (const response of [
    { ...ok(), headers: { etag: '"agent-8-2"' } },
    ok({ ...detail, definition: { ...detail.definition, revision: 2 } }),
    ok({ ...detail, fieldPolicy: { editablePaths: ["/name"] } }),
  ]) await assert.rejects(createDefinitionApi(async () => response).detail(4), /contract|ETag/i);
});

test("bounded detail omits tools, validates selected IDs and sends tool bindings only with their own capability", async () => {
  const { tools: _legacy, ...bounded } = detail;
  const payload = { ...bounded, toolBindings: [3, 47], capabilities: { ...bounded.capabilities, writeToolBindings: true } };
  const calls: any[] = [];
  const api = createDefinitionApi(async (path, init) => { calls.push({ path, init }); return ok(payload); });
  const record = await api.detail(4);
  assert.equal(Object.hasOwn(record, "tools"), false);
  assert.deepEqual(record.toolBindings, [3, 47]);
  await api.patch(record, {}, undefined, [47, 61]);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { changes: {}, toolBindings: [47, 61] });
  assert.equal(calls.at(-1).init.headers["If-Match"], record.etag);
  const before = calls.length;
  await assert.rejects(api.patch({ ...record, capabilities: { ...record.capabilities, writeToolBindings: false } }, {}, undefined, []), /forbidden/);
  assert.equal(calls.length, before);
  for (const invalid of [[0], [-1], [1, 1], ["3"], null]) {
    await assert.rejects(createDefinitionApi(async () => ok({ ...payload, toolBindings: invalid })).detail(4), /contract/);
  }
});

test("tool adapter uses bounded third-page search and selected metadata with cancellation", async () => {
  const controller = new AbortController(), calls: any[] = [];
  const api = createDefinitionApi(async (path, init) => {
    calls.push({ path, init });
    const q = new URL(path, "http://fixture.test").searchParams;
    return { status: 200, headers: {}, body: { code: 0, data: [{ id: 47, name: "Tool 47", skillIds: [9] }],
      total: 61, page: Number(q.get("page")), pageSize: Number(q.get("pageSize")), hasMore: true } };
  });
  await api.toolsPage({ page: 3, pageSize: 20, search: "tool" }, controller.signal);
  assert.equal(calls[0].path, "/api/v1/addons/tool/catalog?page=3&pageSize=20&search=tool");
  assert.equal(calls[0].init.signal, controller.signal);
  await api.toolsPage({ page: 1, pageSize: 50, search: "", ids: [3, 47] }, controller.signal);
  assert.match(calls[1].path, /ids=3%2C47$/);
  await assert.rejects(createDefinitionApi(async () => ({ status: 200, headers: {}, body: {
    code: 0, data: [{ id: 0, name: "invalid" }], total: 1, page: 1, pageSize: 20, hasMore: false,
  } })).toolsPage({ page: 1, pageSize: 20, search: "" }), /Invalid tool page/);
});

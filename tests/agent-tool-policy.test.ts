import assert from "node:assert/strict";
import { test } from "node:test";
import { createDefinitionApi, toolChanges, type ToolDetail } from "../src/agent-definition/api.ts";

const root = "/config/mcp_config/input_schema";
function record(): ToolDetail {
  return {
    tool: { id: 7, revision: "3", name: "Tool", slug: "tool", isActive: true },
    etag: '"tool-7-3"', capabilities: { read: true, write: true },
    fieldPolicy: {
      editablePaths: [`${root}/required`], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {},
      schemaPropertyRules: [{
        parentPath: root, propertyPathTemplate: `${root}/properties/{property}/{keyword}`,
        propertyNamePattern: "^[A-Za-z_][A-Za-z0-9_-]{0,63}$", keywords: ["type", "description"],
        reservedPropertyNames: ["opaque"], forbiddenNameFragments: ["token", "password", "secret", "apikey"],
      }],
    },
  };
}
test("server schema rules authorize new safe leaves and atomic required changes", () => {
  const changes = { [`${root}/properties/probe/type`]: "boolean", [`${root}/required`]: ["probe"] };
  assert.deepEqual(toolChanges(record(), changes), changes);
});
test("schema rules never imply wildcard, reserved, nested or sensitive permission", () => {
  for (const name of ["opaque", "api_key", "api-key", "token", "env", "headers", "__proto__", "constructor", "prototype", "a/b", "a~b"]) {
    assert.throws(() => toolChanges(record(), { [`${root}/properties/${name}/type`]: "string" }), /policy/);
  }
  for (const path of [`${root}/properties/probe/default`, `${root}/properties/probe/properties/nested/type`]) {
    assert.throws(() => toolChanges(record(), { [path]: "string" }), /policy/);
  }
  const absent = record(); delete absent.fieldPolicy.schemaPropertyRules;
  assert.throws(() => toolChanges(absent, { [`${root}/properties/probe/type`]: "boolean" }), /policy/);
  const protectedRecord = record(); protectedRecord.fieldPolicy.protectedPaths.push(`${root}/properties/probe`);
  assert.throws(() => toolChanges(protectedRecord, { [`${root}/properties/probe/type`]: "boolean" }), /policy/);
});
test("tool DELETE requires own exact CAS and accepts the no-data success envelope", async () => {
  const calls: any[] = [];
  const api = createDefinitionApi(async (path, init) => {
    calls.push({ path, init }); return { status: 200, headers: {}, body: { code: 0, message: "deleted" } };
  });
  await api.deleteTool(record());
  assert.equal(calls[0].path, "/api/v1/addons/tool/7");
  assert.equal(calls[0].init.method, "DELETE");
  assert.equal(calls[0].init.headers["If-Match"], '"tool-7-3"');
  await assert.rejects(api.deleteTool({ ...record(), etag: '"tool-7-2"' }), /ETag/);
  await assert.rejects(api.deleteTool({ ...record(), capabilities: { read: true, write: false } }), /forbidden/);
  assert.equal(calls.length, 1);
});
test("malformed dynamic schema policies fail closed at the response boundary", async () => {
  const rule = record().fieldPolicy.schemaPropertyRules![0];
  for (const rules of [null, {}, [null], [{ ...rule, keywords: null }], [{ ...rule, keywords: [1] }],
    [{ ...rule, propertyNamePattern: "[" }], [{ ...rule, parentPath: "/config/mcp_config/input_schema_other" }],
    [{ ...rule, propertyPathTemplate: "/config/{property}/{keyword}" }]]) {
    const data = record();
    (data.fieldPolicy as any).schemaPropertyRules = rules;
    const api = createDefinitionApi(async () => ({
      status: 200, headers: { etag: data.etag }, body: { code: 0, data },
    }));
    await assert.rejects(api.tool(7), /Invalid tool contract/);
  }
});

import assert from "node:assert/strict";
import test from "node:test";
import { loadComponent, render } from "./render.ts";
import { createDefinitionApi, DefinitionError, type Detail } from "../src/agent-definition/api.ts";
import { errorKey, text } from "../src/agent-definition/messages.ts";

const detail = (over: Partial<Detail["definition"]> = {}) => ({
  definition: { id: 1, name: "one", slug: "one", revision: "1", config: { description: "d", prompt: "p" }, isActive: false, ...over },
  capabilities: { read: true, write: true, readSkills: true, writeSkillBindings: true, writeIdentity: true, delete: true },
  fieldPolicy: { editablePaths: ["/name", "/config/defaults/model"], readOnlyPaths: [], protectedPaths: [], unknownPaths: [], reasons: {} },
  identity: { uid: 7, status: "ready" }, effective: { revision: "abc", definitionRevision: "1" },
  skills: [], skillBindings: [], tools: [], etag: '"agent-1-1"',
}) as unknown as Detail;
const impact = { instances: 0, conversations: 0, conversations_7d: 0, skill_bindings: 0, im_groups: 0, deliverables: 0, unavailable: [], counted_at: "now" };

async function mount(path: string, props: Record<string, unknown>, before?: (b: any) => void) {
  const originalDocument = globalThis.document;
  globalThis.document = { activeElement: null } as unknown as Document;
  const component = await loadComponent(path) as { setup: Function };
  const setup = component.setup;
  let bindings: any;
  component.setup = function (p: unknown, c: unknown) { bindings = setup(p, c); before?.(bindings); return bindings; };
  try {
    const html = await render(component, props, "zh");
    return { html, bindings, restore: () => { component.setup = setup; globalThis.document = originalDocument; } };
  } catch (error) { component.setup = setup; globalThis.document = originalDocument; throw error; }
}

test("backend error codes map to Chinese reasons instead of the generic failure", () => {
  const zh = (code: string, status = 422) => text(errorKey(new DefinitionError(status, code)), "zh");
  assert.equal(zh("agent_definition_im_requires_model"), "请先选择模型，再启用这个智能体。");
  assert.match(zh("agent_identity_not_ready", 409), /IM 身份/);
  assert.match(zh("agent_identity_revoked", 409), /IM 身份/);
  assert.match(zh("agent_definition_active", 409), /先停用/);
  assert.equal(errorKey(new DefinitionError(403, "forbidden")), "denied");
  assert.equal(errorKey(new Error("network")), "error");
  assert.equal(errorKey(new DefinitionError(500, "request_failed_500")), "error");
});

test("enable is disabled with a hint while the model is empty, and allowed once a model is chosen", async () => {
  const empty = await mount("src/agent-definition/DefinitionDrawer.vue", { detail: detail(), api: {} });
  try {
    assert.match(empty.html, /<button[^>]*disabled[^>]*title="请先选择模型"[^>]*>[\s\S]{0,400}?启用/);
    assert.match(empty.html, /请先选择模型/);
  } finally { empty.restore(); }
  const chosen = await mount("src/agent-definition/DefinitionDrawer.vue",
    { detail: detail({ config: { description: "d", prompt: "p", defaults: { model: "codex" } } } as never), api: {} });
  try { assert.doesNotMatch(chosen.html, /title="请先选择模型"/); } finally { chosen.restore(); }
});

test("a 422 enable failure shows the translated reason", async () => {
  const record = detail({ config: { defaults: { model: "codex" } } } as never);
  const { bindings, restore } = await mount("src/agent-definition/DefinitionDrawer.vue", {
    detail: record,
    api: { impact: async () => impact, detail: async () => record,
      lifecycle: async () => { throw new DefinitionError(422, "agent_definition_im_requires_model"); } },
  });
  try {
    await bindings.prepare("enable");
    bindings.acknowledged.value = true;
    await bindings.confirmAction();
    assert.equal(bindings.status.value, "modelRequired");
  } finally { restore(); }
});

test("list shows every non-deleted row by default and keeps deleted rows in the recycle bin filter", async () => {
  const rows = [detail().definition, { ...detail().definition, id: 2, isActive: true },
    { ...detail().definition, id: 3, deletedAt: "2026-10-13T00:00:00Z" }];
  const { html, bindings, restore } = await mount("src/agent-definition/AgentManagement.vue", { api: {} }, b => { b.definitions.value = rows; });
  try {
    assert.deepEqual(bindings.visible.value.map((row: { id: number }) => row.id), [1, 2]);
    assert.match(html, /回收站[^<]*<span[^>]*>1</);
    assert.match(html, /全部[^<]*<span[^>]*>2</);
    bindings.filter.value = "deleted";
    assert.deepEqual(bindings.visible.value.map((row: { id: number }) => row.id), [3]);
  } finally { restore(); }
});

test("recommended import previews then posts once; skipped rows say they already exist", async () => {
  const calls: string[] = [];
  const rows = [{ slug: "translator", name: "翻译官", description: "x", status: "create" },
    { slug: "code-mentor", name: "代码老师傅", description: "y", status: "skipped", reason: "exists", id: 9 }];
  const api = createDefinitionApi(async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    return { status: 200, headers: {}, body: { code: 0, data: rows } };
  });
  assert.deepEqual(await api.recommended(), rows);
  await api.importRecommended();
  assert.deepEqual(calls, ["GET /api/v1/addons/admin/agents/recommended", "POST /api/v1/addons/admin/agents/import-recommended"]);

  const catalog = { capabilities: { read: true, create: true } };
  const { html, restore } = await mount("src/agent-definition/AgentManagement.vue", { api: {} }, b => {
    b.catalog.value = catalog; b.recommended.value = rows;
  });
  try {
    assert.match(html, /导入推荐智能体/);
    assert.match(html, /翻译官[\s\S]*将导入/);
    assert.match(html, /代码老师傅[\s\S]*已存在，跳过/);
  } finally { restore(); }
});

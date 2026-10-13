import { buildChanges, readPath, validateChanges, type Binding, type Changes } from "./draft.ts";

export interface Definition {
  id: number; name: string; slug: string; revision: string; isActive: boolean;
  authAgentUserId?: number | null; deletedAt?: string | null; deletedBy?: number | null;
  createdAt?: string; updatedAt?: string;
  config?: Record<string, unknown>; i18n?: Record<string, unknown>;
}
export interface Capabilities {
  read: boolean; write: boolean; writeIdentity: boolean; delete: boolean; restore: boolean;
  readSkills: boolean; writeSkillBindings: boolean; readTools: boolean; writeTools: boolean;
}
export interface FieldPolicy {
  editablePaths: string[]; readOnlyPaths: string[]; protectedPaths: string[];
  unknownPaths: { path: string; type: string }[]; reasons: Record<string, string>;
  schemaPropertyRules?: SchemaPropertyRule[];
}
export interface SchemaPropertyRule {
  parentPath: string; propertyPathTemplate: string; propertyNamePattern: string;
  keywords: string[]; reservedPropertyNames: string[]; forbiddenNameFragments: string[];
}
export interface Skill {
  id: number; name: string; slug: string; version?: string; sourceSHA256?: string; isActive: boolean;
  defaultInstallPath?: string;
}
export interface Catalog { capabilities: Capabilities & { create: boolean }; fieldPolicy: FieldPolicy; skills: Skill[] }
export interface Tool {
  id: number; name: string; slug: string; revision: string; isActive: boolean; source?: string;
  config?: Record<string, unknown>; i18n?: Record<string, unknown>;
}
export interface ToolDetail { tool: Tool; capabilities: { read: boolean; write: boolean }; fieldPolicy: FieldPolicy; etag: string }
export interface Detail {
  definition: Definition; capabilities: Capabilities; fieldPolicy: FieldPolicy;
  skillBindings: Binding[]; skills: Skill[]; tools: Tool[];
  effective: { revision: string; definitionRevision: string; dependencies?: unknown[]; modelRule?: string; promptRule?: string; inFlightRule?: string; overrideRule?: string };
  identity: { uid: number | null; status: "pending" | "ready" | "failed"; projectionRevision?: string; lastErrorCode?: string };
  instanceCount?: number; sessions7d?: number; etag: string;
}
export interface Impact {
  instances: number; conversations: number; conversations_7d: number; skill_bindings: number;
  im_groups: number | null; deliverables: number | null; unavailable: string[]; counted_at: string;
}
export interface DefinitionEvent {
  id: string; definitionId: number; revision: string; kind: string;
  changedPaths: string[]; resourceType?: string; resourceId?: number;
}
export interface Audit { id: number; action: string; actorUserId: number; fields: string[]; promptSha256Before: string; promptSha256After: string; createdAt: string }
export interface Instance { instanceId: number; userId: number; nickName: string; firstUsedAt: string; sessionCount: number; lastSessionAt: string | null }
export interface TransportResponse { status: number; headers: Record<string, string>; body: unknown }
export type Transport = (path: string, init?: RequestInit) => Promise<TransportResponse>;
export type LifecycleAction = "enable" | "disable" | "delete" | "restore" | "retry";

export class DefinitionError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = "DefinitionError";
    this.status = status;
    this.code = code;
  }
}
const BASE = "/api/v1/addons/admin/agents";
const idPath = (id: number) => {
  if (!Number.isSafeInteger(id) || id < 1) throw new Error("Invalid definition ID");
  return `${BASE}/${id}`;
};
const strongETag = (value: string | undefined): value is string => !!value && /^"[^"\r\n]+"$/.test(value);
const revision = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(v => typeof v === "string");
function validSchemaRule(rule: SchemaPropertyRule): boolean {
  const root = "/config/mcp_config/input_schema";
  if (!rule || typeof rule.parentPath !== "string"
    || !(rule.parentPath === root || rule.parentPath.startsWith(`${root}/`))
    || rule.propertyPathTemplate !== `${rule.parentPath}/properties/{property}/{keyword}`
    || typeof rule.propertyNamePattern !== "string"
    || !strings(rule.keywords) || !strings(rule.reservedPropertyNames) || !strings(rule.forbiddenNameFragments)) return false;
  try { new RegExp(rule.propertyNamePattern); return true; } catch { return false; }
}
const validPolicy = (p: FieldPolicy) => p && ["editablePaths", "readOnlyPaths", "protectedPaths"].every(
  key => Array.isArray(p[key as keyof FieldPolicy]) && (p[key as keyof FieldPolicy] as unknown[]).every(v => typeof v === "string"))
  && Array.isArray(p.unknownPaths) && p.unknownPaths.every(v => v && typeof v.path === "string" && typeof v.type === "string")
  && p.reasons && typeof p.reasons === "object" && !Array.isArray(p.reasons)
  && Object.values(p.reasons).every(v => typeof v === "string")
  && (p.schemaPropertyRules === undefined || (Array.isArray(p.schemaPropertyRules) && p.schemaPropertyRules.every(validSchemaRule)));
const validCapabilities = (c: Capabilities) => c && ["read", "write", "writeIdentity", "delete", "restore", "readSkills", "writeSkillBindings", "readTools", "writeTools"]
  .every(key => typeof c[key as keyof Capabilities] === "boolean");
const requestKey = (key: string) => {
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new Error("Invalid idempotency key");
  return key;
};
export function schemaPropertyPath(rule: SchemaPropertyRule, name: string, keyword: string): string {
  if (!validSchemaRule(rule)) throw new Error("Unsupported tool field policy");
  const compact = name.toLowerCase().replace(/[_-]/g, "");
  const unsafe = ["__proto__", "constructor", "prototype", "env", "headers"].includes(name)
    || ["env", "headers"].includes(compact);
  if (!name || name.length > 64 || /[/~]/.test(name) || unsafe
    || !new RegExp(rule.propertyNamePattern).test(name) || !rule.keywords.includes(keyword)
    || rule.reservedPropertyNames.includes(name)
    || rule.forbiddenNameFragments.some(part => compact.includes(part.toLowerCase().replace(/[_-]/g, "")))
    || /[/~]/.test(keyword)) {
    throw new Error("Unsupported tool field policy");
  }
  return rule.propertyPathTemplate.replace("{property}", name).replace("{keyword}", keyword);
}
function schemaPathAllowed(policy: FieldPolicy, path: string): boolean {
  return (policy.schemaPropertyRules ?? []).some(rule => {
    const prefix = `${rule.parentPath}/properties/`;
    if (!path.startsWith(prefix)) return false;
    const [name, keyword, extra] = path.slice(prefix.length).split("/");
    if (!name || !keyword || extra !== undefined) return false;
    try { return schemaPropertyPath(rule, name, keyword) === path; } catch { return false; }
  });
}
export function toolChanges(record: ToolDetail, draft: Changes): Changes {
  const changes: Changes = {};
  for (const [path, value] of Object.entries(draft)) {
    const known = ["/name", "/isActive", "/config/description", "/config/mcp_config/description"].includes(path)
      || path.startsWith("/config/mcp_config/input_schema/");
    if (!known || !(record.fieldPolicy.editablePaths.includes(path) || schemaPathAllowed(record.fieldPolicy, path))
      || record.fieldPolicy.protectedPaths.some(p => path === p || path.startsWith(`${p}/`))
      || value === undefined) throw new Error("Unsupported tool field policy");
    if (JSON.stringify(readPath(record.tool, path)) !== JSON.stringify(value)) changes[path] = value;
  }
  return changes;
}

export function createDefinitionApi(transport: Transport) {
  async function request<T>(path: string, init?: RequestInit, empty = false): Promise<{ data: T; etag?: string; typesAvailable?: boolean; total?: number }> {
    const response = await transport(path, { cache: "no-store", ...init });
    const envelope = response.body as { code?: number | string; typesAvailable?: boolean; total?: number; data?: T & { error?: string } };
    if (response.status < 200 || response.status >= 300 || envelope?.code !== 0) {
      throw new DefinitionError(response.status, typeof envelope?.code === "string" ? envelope.code : `request_failed_${response.status}`);
    }
    if (envelope.data == null && !empty) throw new Error("Invalid definition contract");
    return { data: envelope.data as T, etag: response.headers.etag, typesAvailable: envelope.typesAvailable, total: envelope.total };
  }
  function aggregate(result: { data: Omit<Detail, "etag">; etag?: string }): Detail {
    const d = result.data;
    if (!strongETag(result.etag)) throw new Error("Missing strong ETag");
    if (!d.definition || !Number.isSafeInteger(d.definition.id) || d.definition.id < 1 || !revision(d.definition.revision)
      || result.etag !== `"agent-${d.definition.id}-${d.definition.revision}"`
      || !validCapabilities(d.capabilities) || !validPolicy(d.fieldPolicy) || !Array.isArray(d.skillBindings)
      || !Array.isArray(d.skills) || !Array.isArray(d.tools)
      || !d.effective?.revision || !d.identity) throw new Error("Invalid definition contract");
    return { ...d, etag: result.etag };
  }
  function mutation(record: Detail, method: string, body?: unknown): RequestInit {
    if (!strongETag(record.etag)) throw new Error("Missing strong ETag");
    return { method, headers: { "If-Match": record.etag, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  }
  function resource(result: { data: Omit<ToolDetail, "etag">; etag?: string }): ToolDetail {
    const d = result.data;
    if (!d.tool || !Number.isSafeInteger(d.tool.id) || d.tool.id < 1 || !revision(d.tool.revision)
      || result.etag !== `"tool-${d.tool.id}-${d.tool.revision}"` || !validPolicy(d.fieldPolicy)
      || typeof d.capabilities?.read !== "boolean" || typeof d.capabilities?.write !== "boolean") throw new Error("Invalid tool contract");
    return { ...d, etag: result.etag };
  }
  return {
    async catalog(): Promise<Catalog> {
      const { data } = await request<Catalog>(`${BASE}/catalog`);
      if (!validCapabilities(data.capabilities) || typeof data.capabilities.create !== "boolean"
        || !validPolicy(data.fieldPolicy) || !Array.isArray(data.skills)) throw new Error("Invalid catalog contract");
      return data;
    },
    async create(catalog: Catalog, slug: string, draft: Changes, key: string, skillBindings?: Binding[]): Promise<Detail> {
      if (catalog.capabilities.create !== true || (skillBindings !== undefined && catalog.capabilities.writeSkillBindings !== true)) {
        throw new DefinitionError(403, "forbidden");
      }
      requestKey(key);
      const changes = buildChanges({}, draft, catalog.fieldPolicy.editablePaths.filter(path => path !== "/slug"));
      if (Object.keys(validateChanges({}, { ...changes, "/slug": slug, "/name": changes["/name"] })).length) {
        throw new DefinitionError(422, "invalid_definition_patch");
      }
      return aggregate(await request<Omit<Detail, "etag">>(BASE, {
        method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key },
        body: JSON.stringify({ slug, changes, ...(skillBindings === undefined ? {} : { skillBindings }) }),
      }));
    },
    async creationResult(key: string): Promise<Detail> {
      return aggregate(await request<Omit<Detail, "etag">>(`${BASE}/requests/${requestKey(key)}`));
    },
    async tool(id: number): Promise<ToolDetail> {
      idPath(id);
      return resource(await request<Omit<ToolDetail, "etag">>(`/api/v1/addons/tool/${id}`));
    },
    async patchTool(record: ToolDetail, draft: Changes): Promise<ToolDetail> {
      if (record.capabilities.write !== true) throw new DefinitionError(403, "forbidden");
      idPath(record.tool.id);
      if (record.etag !== `"tool-${record.tool.id}-${record.tool.revision}"`) throw new Error("Invalid tool ETag");
      return resource(await request<Omit<ToolDetail, "etag">>(`/api/v1/addons/tool/${record.tool.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", "If-Match": record.etag },
        body: JSON.stringify({ changes: toolChanges(record, draft) }),
      }));
    },
    async deleteTool(record: ToolDetail): Promise<void> {
      if (record.capabilities.write !== true) throw new DefinitionError(403, "forbidden");
      idPath(record.tool.id);
      if (record.etag !== `"tool-${record.tool.id}-${record.tool.revision}"`) throw new Error("Invalid tool ETag");
      await request(`/api/v1/addons/tool/${record.tool.id}`, {
        method: "DELETE", headers: { "If-Match": record.etag },
      }, true);
    },
    async recommended(): Promise<RecommendedRow[]> {
      const { data } = await request<RecommendedRow[]>(`${BASE}/recommended`);
      if (!Array.isArray(data)) throw new Error("Invalid recommended contract");
      return data;
    },
    async importRecommended(): Promise<RecommendedRow[]> {
      const { data } = await request<RecommendedRow[]>(`${BASE}/import-recommended`, { method: "POST" });
      if (!Array.isArray(data)) throw new Error("Invalid recommended contract");
      return data;
    },
    async list(): Promise<Definition[]> {
      const { data } = await request<Definition[]>(`${BASE}?include_deleted=1`);
      if (!Array.isArray(data)) throw new Error("Invalid definition list contract");
      return data;
    },
    async detail(id: number): Promise<Detail> {
      return aggregate(await request<Omit<Detail, "etag">>(idPath(id)));
    },
    async patch(record: Detail, changes: Changes, skillBindings?: Binding[]): Promise<Detail> {
      if (!record.capabilities.write || (skillBindings !== undefined && !record.capabilities.writeSkillBindings)) {
        throw new DefinitionError(403, "forbidden");
      }
      const body = { changes: buildChanges(record.definition, changes, record.fieldPolicy.editablePaths),
        ...(skillBindings === undefined ? {} : { skillBindings }) };
      return aggregate(await request<Omit<Detail, "etag">>(idPath(record.definition.id), mutation(record, "PATCH", body)));
    },
    async lifecycle(record: Detail, action: LifecycleAction): Promise<Detail> {
      if (action === "delete" && record.definition.isActive) throw new Error("Definition must be inactive");
      const permission = action === "delete" ? "delete" : action === "restore" ? "restore" : "writeIdentity";
      if (record.capabilities[permission] !== true) throw new DefinitionError(403, "forbidden");
      const path = idPath(record.definition.id);
      const init = action === "delete" ? mutation(record, "DELETE")
        : action === "restore" || action === "retry" ? mutation(record, "POST")
          : mutation(record, "PATCH", { changes: { "/isActive": action === "enable" } });
      const suffix = action === "restore" ? "/restore" : action === "retry" ? "/identity/retry" : "";
      return aggregate(await request<Omit<Detail, "etag">>(`${path}${suffix}`, init));
    },
    async impact(id: number): Promise<Impact> {
      const { data } = await request<Impact>(`${idPath(id)}/impact`);
      if (!data.counted_at || !Array.isArray(data.unavailable)) throw new Error("Invalid impact contract");
      return data;
    },
    async events(after: string): Promise<{ events: DefinitionEvent[]; nextCursor: string; hasMore: boolean }> {
      if (!/^\d+$/.test(after)) throw new Error("Invalid event cursor");
      return (await request<{ events: DefinitionEvent[]; nextCursor: string; hasMore: boolean }>(
        `${BASE}/events?${new URLSearchParams({ after, limit: "100" })}`)).data;
    },
    async models(): Promise<{ providerId: number; model: string; type: string }[]> {
      const { data, typesAvailable } = await request<{ providerId: number; model: string; type: string }[]>(
        "/api/v1/addons/provider/models?type=chat");
      if (typesAvailable !== true || !Array.isArray(data)) throw new Error("Model catalog unavailable");
      return data;
    },
    async backends(): Promise<{ id: string; displayName: string }[]> {
      const { data } = await request<{ id: string; displayName: string }[]>("/api/v1/addons/conversation/execution-backends");
      if (!Array.isArray(data)) throw new Error("Backend catalog unavailable");
      return data;
    },
    async audits(id: number, offset = 0): Promise<{ items: Audit[]; total: number }> {
      const result = await request<Audit[]>(`${idPath(id)}/audits?${new URLSearchParams({ offset: String(offset), limit: "20" })}`);
      if (!Array.isArray(result.data)) throw new Error("Invalid audit contract");
      return { items: result.data, total: result.total ?? result.data.length };
    },
    async instances(id: number, offset = 0): Promise<{ items: Instance[]; total: number }> {
      const result = await request<Instance[]>(`${idPath(id)}/instances?${new URLSearchParams({ offset: String(offset), limit: "20" })}`);
      if (!Array.isArray(result.data)) throw new Error("Invalid instance contract");
      return { items: result.data, total: result.total ?? result.data.length };
    },
  };
}
export interface RecommendedRow { slug: string; name: string; description: string; status: "create" | "created" | "skipped"; reason?: "exists" | "deleted"; id?: number }
export type DefinitionApi = ReturnType<typeof createDefinitionApi>;

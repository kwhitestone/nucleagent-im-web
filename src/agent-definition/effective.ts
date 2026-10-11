import { DefinitionError, type Transport } from "./api.ts";

export type Source = "template" | "instance" | "conversation";
export interface Materials {
  definitionRevision: string; identityRevision: string; effectiveRevision: string;
  promptSources: ("template" | "instance")[]; modelSource: Source; backendSource: Source; skillSource: "template";
  skills: { id: number; revision: string; source: string; fingerprint: string }[];
  tools: { id: number; revision: string; source: "global" | "template"; skillId?: number; fingerprint: string }[];
  bindings: { id: number; skillId: number; source: Source; executing: boolean }[];
}
export interface EffectiveDefinition {
  definitionId: number; definitionRevision: string; instanceId: number; conversationId?: number;
  enabled: boolean; deleted: boolean; stale: boolean; current: Materials | null; admitted: Materials | null;
}
const id = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;
const revision = (value: unknown): value is string => typeof value === "string" && /^\d+$/.test(value);
const source = (value: unknown): value is Source => ["template", "instance", "conversation"].includes(String(value));
function material(value: Materials | null): Materials | null {
  if (value === null) return null;
  if (!value || !revision(value.definitionRevision) || !revision(value.identityRevision) || typeof value.effectiveRevision !== "string"
    || !source(value.modelSource) || !source(value.backendSource) || value.skillSource !== "template"
    || !Array.isArray(value.promptSources) || !value.promptSources.every(v => v === "template" || v === "instance")
    || !Array.isArray(value.skills) || !Array.isArray(value.tools) || !Array.isArray(value.bindings)) throw new Error("Invalid effective contract");
  const resource = (r: Materials["skills"][number]) => {
    if (!id(r.id) || !revision(r.revision) || typeof r.fingerprint !== "string") throw new Error("Invalid effective resource contract");
    return { id: r.id, revision: r.revision, fingerprint: r.fingerprint };
  };
  // Project only metadata: extra server fields must never become a private prompt view.
  return {
    definitionRevision: value.definitionRevision, identityRevision: value.identityRevision, effectiveRevision: value.effectiveRevision,
    promptSources: [...value.promptSources], modelSource: value.modelSource, backendSource: value.backendSource, skillSource: "template",
    skills: value.skills.map(r => ({ ...resource(r), source: r.source })),
    tools: value.tools.map(r => {
      if (!["global", "template"].includes(r.source)) throw new Error("Invalid effective source contract");
      return { ...resource(r), source: r.source, ...(id(r.skillId) ? { skillId: r.skillId } : {}) };
    }),
    bindings: value.bindings.map(r => {
      if (!id(r.id) || !id(r.skillId) || !source(r.source) || typeof r.executing !== "boolean") throw new Error("Invalid effective binding contract");
      return { id: r.id, skillId: r.skillId, source: r.source, executing: r.executing };
    }),
  };
}
export function createEffectiveApi(transport: Transport) {
  async function read(path: string): Promise<EffectiveDefinition> {
    const response = await transport(path, { cache: "no-store" });
    const body = response.body as { code: number | string; data: EffectiveDefinition };
    if (response.status < 200 || response.status >= 300 || body?.code !== 0) {
      throw new DefinitionError(response.status, typeof body?.code === "string" ? body.code : "effective_unavailable");
    }
    const d = body.data;
    if (!d || !id(d.definitionId) || !id(d.instanceId) || !revision(d.definitionRevision)
      || (d.conversationId !== undefined && !id(d.conversationId))
      || [d.enabled, d.deleted, d.stale].some(v => typeof v !== "boolean")) throw new Error("Invalid effective contract");
    return { definitionId: d.definitionId, definitionRevision: d.definitionRevision, instanceId: d.instanceId,
      ...(d.conversationId === undefined ? {} : { conversationId: d.conversationId }),
      enabled: d.enabled, deleted: d.deleted, stale: d.stale, current: material(d.current), admitted: material(d.admitted) };
  }
  return {
    async uid(agentUid: number) {
      if (!id(agentUid)) throw new Error("Invalid agent UID");
      return read(`/api/v1/addons/conversation/agent-uid/${agentUid}/effective-definition`);
    },
    async instance(instanceId: number) {
      if (!id(instanceId)) throw new Error("Invalid instance ID");
      return read(`/api/v1/addons/conversation/agent-instances/${instanceId}/effective-definition`);
    },
    async conversation(conversationId: number) {
      if (!id(conversationId)) throw new Error("Invalid conversation ID");
      return read(`/api/v1/addons/conversation/${conversationId}/effective-definition`);
    },
  };
}
export type EffectiveApi = ReturnType<typeof createEffectiveApi>;

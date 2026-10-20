import { DefinitionError, type DefinitionApi, type Detail, type Impact } from "./api.ts";
import { buildChanges, newerRevision, rebaseChanges, type Binding, type Changes } from "./draft.ts";
import { errorKey } from "./messages.ts";

const bindingKey = (bindings: Binding[]) => JSON.stringify([...bindings].sort((a, b) => a.skillId - b.skillId));
const toolKey = (ids: number[] = []) => JSON.stringify([...ids].sort((a, b) => a - b));
export class DefinitionEditor {
  record: Detail | null = null;
  current: Detail | null = null;
  changes: Changes = {};
  bindings: Binding[] | undefined;
  tools: number[] | undefined;
  busy = false;
  denied = false;
  error = "";
  verificationRequired = false;
  private generation = 0;
  private refreshGeneration = 0;

  get dirty(): boolean { return Object.keys(this.changes).length > 0 || this.bindings !== undefined || this.tools !== undefined; }
  get bindingConflict(): boolean {
    return !!this.record && !!this.current && this.bindings !== undefined
      && bindingKey(this.record.skillBindings) !== bindingKey(this.current.skillBindings)
      && bindingKey(this.bindings) !== bindingKey(this.current.skillBindings);
  }
  get toolConflict(): boolean {
    return !!this.record && !!this.current && this.tools !== undefined
      && toolKey(this.record.toolBindings) !== toolKey(this.current.toolBindings)
      && toolKey(this.tools) !== toolKey(this.current.toolBindings);
  }
  open(record: Detail): void {
    this.generation++;
    this.record = record; this.current = null; this.changes = {}; this.bindings = undefined; this.tools = undefined;
    this.busy = false; this.denied = false; this.error = ""; this.verificationRequired = false;
  }
  clear(): void {
    this.generation++; this.record = null; this.current = null; this.changes = {};
    this.bindings = undefined; this.tools = undefined; this.busy = false; this.denied = false; this.error = ""; this.verificationRequired = false;
  }
  revokeRead(): void {
    this.clear(); this.denied = true; this.error = "readDenied";
  }
  change(path: string, value: unknown): void {
    if (!this.record || this.denied || this.busy || !this.record.capabilities.write) return;
    this.changes = buildChanges(this.record.definition, { ...this.changes, [path]: value }, this.record.fieldPolicy.editablePaths);
    this.error = "";
  }
  acceptRefresh(record: Detail): void {
    if (!this.record || record.definition.id !== this.record.definition.id) return;
    if (!record.capabilities.read) { this.revokeRead(); return; }
    if (newerRevision((this.current ?? this.record).definition.revision, record.definition.revision)) return;
    this.refreshGeneration++;
    if (!record.capabilities.readTools) record = { ...record, tools: undefined, toolBindings: [] };
    this.verificationRequired = false;
    if (this.error === "uncertain") this.error = "";
    if (this.record.capabilities.write && !record.capabilities.write) {
      this.denied = true;
      this.error = "denied";
    } else this.denied = false;
    const changed = record.definition.revision !== this.record.definition.revision
      || record.effective.revision !== this.record.effective.revision;
    this.record = { ...this.record, capabilities: record.capabilities, fieldPolicy: record.fieldPolicy,
      ...(!record.capabilities.readSkills ? { skills: [], skillBindings: [] } : {}),
      ...(!record.capabilities.readTools ? { tools: undefined, toolBindings: [] } : {}) };
    if (!record.capabilities.readSkills) this.bindings = undefined;
    if (!record.capabilities.readTools || record.capabilities.writeToolBindings !== true) this.tools = undefined;
    if (this.dirty && (changed || this.current)) {
      // An identical re-read (412 reread, then the event poll) keeps the open comparison and the user's choices.
      if (JSON.stringify(record) !== JSON.stringify(this.current)) this.current = record;
      this.error = "conflict";
    }
    else if (!this.dirty) {
      this.record = record; this.current = null;
      if (this.error === "conflict") this.error = "";
    }
    else this.record = { ...this.record, capabilities: record.capabilities, fieldPolicy: record.fieldPolicy };
  }
  resolve(choices: Record<string, "mine" | "current">, bindingChoice?: "mine" | "current", toolChoice?: "mine" | "current"): void {
    if (!this.record || !this.current) return;
    // Conflict data is not an authority source; use the latest accepted policy.
    const { capabilities, fieldPolicy } = this.record;
    this.current = { ...this.current, capabilities, fieldPolicy,
      ...(!capabilities.readSkills ? { skills: [], skillBindings: [] } : {}),
      ...(!capabilities.readTools ? { tools: undefined, toolBindings: [] } : {}) };
    if (!capabilities.readSkills) this.bindings = undefined;
    if (!capabilities.readTools || capabilities.writeToolBindings !== true) this.tools = undefined;
    if (this.bindingConflict && !bindingChoice) throw new Error("Explicit binding choice required");
    if (this.toolConflict && !toolChoice) throw new Error("Explicit tool binding choice required");
    this.changes = rebaseChanges(this.record.definition, this.changes, this.current.definition, choices);
    if (bindingChoice === "current" || (this.bindings && bindingKey(this.bindings) === bindingKey(this.current.skillBindings))) {
      this.bindings = undefined;
    }
    if (toolChoice === "current" || (this.tools && toolKey(this.tools) === toolKey(this.current.toolBindings))) this.tools = undefined;
    this.record = this.current; this.current = null; this.error = "";
  }
  async save(api: DefinitionApi): Promise<Detail | null> {
    if (!this.record?.capabilities.write || !this.dirty || this.busy || this.denied || this.current || this.verificationRequired) return null;
    const generation = this.generation;
    const refreshGeneration = this.refreshGeneration;
    const record = this.record;
    this.busy = true; this.error = "";
    try {
      const saved = await api.patch(record, this.changes, this.bindings, this.tools);
      if (generation !== this.generation) return null;
      if (refreshGeneration !== this.refreshGeneration) {
        const accepted = this.current ?? this.record;
        // An own-write event may arrive first; only an identical accepted snapshot can complete it.
        if (JSON.stringify(saved) === JSON.stringify(accepted)) {
          this.open(accepted);
          return accepted;
        }
        this.verificationRequired = true; this.error = "uncertain"; return null;
      }
      this.open(saved);
      return saved;
    } catch (error) {
      if (generation !== this.generation) return null;
      if (refreshGeneration !== this.refreshGeneration) {
        if (!(error instanceof DefinitionError) || error.status >= 500) {
          this.verificationRequired = true; this.error = "uncertain";
        }
        return null;
      }
      if (error instanceof DefinitionError && [401, 403].includes(error.status)) {
        this.denied = true; this.error = "denied";
      } else if (error instanceof DefinitionError && error.status === 412) {
        this.error = "conflict";
        try {
          const current = await api.detail(record.definition.id);
          if (generation === this.generation && refreshGeneration === this.refreshGeneration) this.acceptRefresh(current);
        } catch (refreshError) {
          if (generation === this.generation && refreshGeneration === this.refreshGeneration && refreshError instanceof DefinitionError && [401, 403].includes(refreshError.status)) {
            this.revokeRead();
          }
        }
      } else {
        this.verificationRequired = !(error instanceof DefinitionError) || error.status >= 500;
        this.error = this.verificationRequired ? "uncertain" : errorKey(error);
      }
      return null;
    } finally {
      if (generation === this.generation) this.busy = false;
    }
  }
}

export function sameImpact(a: Impact, b: Impact): boolean {
  return (["instances", "conversations", "conversations_7d", "skill_bindings", "im_groups", "deliverables"] as const)
    .every(key => a[key] === b[key])
    && JSON.stringify([...a.unavailable].sort()) === JSON.stringify([...b.unavailable].sort());
}

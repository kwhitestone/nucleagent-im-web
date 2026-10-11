import { DefinitionError, type Catalog, type DefinitionApi, type Detail } from "./api.ts";
import type { Binding, Changes } from "./draft.ts";

export class CreationDraft {
  readonly key: string;
  slug = "";
  changes: Changes = {};
  bindings: Binding[] | undefined;
  busy = false;
  uncertain = false;
  completed = false;
  denied = false;
  error = "";
  private pending: { slug: string; changes: Changes; bindings?: Binding[] } | null = null;
  constructor(key: string) { this.key = key; }
  get frozen(): boolean { return this.pending !== null; }
  async submit(api: DefinitionApi, catalog: Catalog): Promise<Detail | null> {
    if (this.busy || this.uncertain || this.completed || this.denied) return null;
    this.pending ??= structuredClone({ slug: this.slug, changes: { ...this.changes }, bindings: this.bindings?.map(b => ({ ...b })) });
    this.busy = true; this.error = "";
    try {
      const saved = await api.create(catalog, this.pending.slug, this.pending.changes, this.key, this.pending.bindings);
      this.completed = true; return saved;
    } catch (error) {
      this.uncertain = !(error instanceof DefinitionError) || error.status >= 500 || error.code === "idempotency_key_conflict";
      this.denied = error instanceof DefinitionError && [401, 403].includes(error.status);
      this.error = this.denied ? "denied" : this.uncertain ? "uncertain" : "error";
      if (!this.uncertain) this.pending = null;
      return null;
    } finally { this.busy = false; }
  }
  async lookup(api: DefinitionApi): Promise<Detail | null> {
    if (this.busy || this.completed) return null;
    this.busy = true;
    try {
      const saved = await api.creationResult(this.key);
      this.uncertain = false; this.completed = true; this.error = ""; return saved;
    } catch (error) {
      if (error instanceof DefinitionError && error.status === 404) { this.uncertain = false; this.error = "retryCreation"; }
      else if (error instanceof DefinitionError && [401, 403].includes(error.status)) { this.denied = true; this.error = "denied"; }
      else { this.uncertain = true; this.error = "uncertain"; }
      return null;
    } finally { this.busy = false; }
  }
}

import type { DefinitionEvent } from "./api.ts";
import { newerRevision } from "./draft.ts";

export function invalidatedDefinitions(after: string, events: DefinitionEvent[], known: Map<number, string>) {
  let cursor = after;
  const ids = new Set<number>();
  for (const event of events) {
    if (typeof event.id !== "string" || !/^\d+$/.test(event.id) || typeof event.revision !== "string"
      || !/^\d+$/.test(event.revision) || !Number.isSafeInteger(event.definitionId) || event.definitionId < 1) {
      throw new Error("Invalid definition event");
    }
    if (!newerRevision(event.id, after)) continue;
    if (newerRevision(event.id, cursor)) cursor = event.id;
    const revision = known.get(event.definitionId);
    if (revision === undefined || newerRevision(event.revision, revision)
      || (event.resourceType && event.resourceType !== "definition" && !newerRevision(revision, event.revision))) {
      ids.add(event.definitionId);
    }
  }
  return { cursor, ids: [...ids] };
}

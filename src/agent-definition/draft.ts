export type Changes = Record<string, unknown>;
export interface Field {
  path: string;
  label: string;
  kind: "text" | "textarea" | "boolean" | "backend" | "provider" | "model";
  max?: number;
}

export const definitionFields: readonly Field[] = [
  { path: "/name", label: "name", kind: "text", max: 128 },
  { path: "/slug", label: "slug", kind: "text", max: 63 },
  { path: "/config/description", label: "description", kind: "textarea", max: 200 },
  { path: "/config/avatar", label: "avatar", kind: "text", max: 1024 },
  { path: "/config/prompt", label: "prompt", kind: "textarea", max: 4000 },
  { path: "/config/memory", label: "memory", kind: "boolean" },
  { path: "/config/defaults/executionBackend", label: "backend", kind: "backend", max: 32 },
  { path: "/config/defaults/providerId", label: "provider", kind: "provider" },
  { path: "/config/defaults/model", label: "model", kind: "model", max: 100 },
];

export function readPath(source: unknown, path: string): unknown {
  return path.slice(1).split("/").map(key => key.replaceAll("~1", "/").replaceAll("~0", "~")).reduce<unknown>((value, key) =>
    value && typeof value === "object" && Object.hasOwn(value, key)
      ? (value as Record<string, unknown>)[key] : undefined, source);
}

export function buildChanges(baseline: unknown, draft: Changes, editablePaths: readonly string[]): Changes {
  const changes: Changes = {};
  for (const [path, value] of Object.entries(draft)) {
    if (!definitionFields.some((field) => field.path === path) || !editablePaths.includes(path)) {
      throw new Error(`Read-only or unsupported field: ${path}`);
    }
    if (value === undefined || (value !== null && !["string", "number", "boolean"].includes(typeof value))) {
      throw new Error(`Invalid field value: ${path}`);
    }
    if (!Object.is(readPath(baseline, path), value)) changes[path] = value;
  }
  return changes;
}

export function compareChanges(baseline: unknown, draft: Changes, current: unknown) {
  return Object.entries(draft).map(([path, mine]) => {
    const before = readPath(baseline, path);
    const now = readPath(current, path);
    return { path, before, mine, current: now, conflict: !Object.is(before, now) && !Object.is(mine, now) };
  });
}

export function rebaseChanges(
  baseline: unknown, draft: Changes, current: unknown, choices: Record<string, "mine" | "current">,
): Changes {
  const result: Changes = {};
  for (const row of compareChanges(baseline, draft, current)) {
    if (row.conflict && !choices[row.path]) throw new Error(`Explicit choice required: ${row.path}`);
    if (choices[row.path] !== "current" && !Object.is(row.mine, row.current)) result[row.path] = row.mine;
  }
  return result;
}

export function newerRevision(candidate: string | number, current: string | number): boolean {
  const valid = (v: string | number) => /^\d+$/.test(String(v)) && (typeof v !== "number" || Number.isSafeInteger(v));
  return valid(candidate) && valid(current) && BigInt(candidate) > BigInt(current);
}

export interface Binding { skillId: number; installPath: string }
export function reconcileBindings(previous: Binding[], selected: number[], catalog: Binding[]): Binding[] {
  return [...new Set(selected)].map((skillId) => {
    const entry = previous.find((b) => b.skillId === skillId) ?? catalog.find((b) => b.skillId === skillId);
    if (!entry) throw new Error(`Skill unavailable: ${skillId}`);
    return { skillId, installPath: entry.installPath };
  });
}

export function validateChanges(baseline: unknown, changes: Changes): Record<string, string> {
  const errors: Record<string, string> = {};
  const value = (path: string) => Object.hasOwn(changes, path) ? changes[path] : readPath(baseline, path);
  for (const field of definitionFields) {
    if (!Object.hasOwn(changes, field.path)) continue;
    const v = changes[field.path];
    if (field.kind === "boolean") {
      if (typeof v !== "boolean") errors[field.path] = "boolean";
    } else if (field.kind !== "provider") {
      if (typeof v !== "string") errors[field.path] = "text";
      else if (field.max && [...v].length > field.max) errors[field.path] = "length";
    }
  }
  if (Object.hasOwn(changes, "/name") && !String(value("/name") ?? "").trim()) errors["/name"] = "required";
  if (Object.hasOwn(changes, "/slug") && !/^[a-z0-9][a-z0-9-]{0,62}$/.test(String(value("/slug") ?? ""))) {
    errors["/slug"] = "slug";
  }
  const avatar = value("/config/avatar");
  if (Object.hasOwn(changes, "/config/avatar") && avatar) {
    try {
      const url = new URL(String(avatar));
      if (url.protocol !== "https:" || url.username || url.password) errors["/config/avatar"] = "avatar";
    } catch { errors["/config/avatar"] = "avatar"; }
  }
  const provider = value("/config/defaults/providerId");
  const model = value("/config/defaults/model");
  if (provider != null && provider !== "" && (!Number.isSafeInteger(provider) || Number(provider) < 1)) {
    errors["/config/defaults/providerId"] = "provider";
  }
  if (Boolean(provider) !== Boolean(typeof model === "string" && model.trim())) errors["/config/defaults/model"] = "modelPair";
  if (readPath(baseline, "/isActive") === true && readPath(baseline, "/authAgentUserId") && !model) {
    errors["/config/defaults/model"] = "modelPair";
  }
  return errors;
}

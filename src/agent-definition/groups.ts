// Presentation-only helpers for the grouped editor. Reads editor state, never writes it.
export const groups = ["basic", "persona", "model", "skills", "visibility", "history", "advanced"] as const;
export type Group = typeof groups[number];

export function fieldGroup(path: string): Group {
  if (["/name", "/slug", "/config/description", "/config/avatar"].includes(path)) return "basic";
  if (path === "/config/prompt" || path === "/config/memory") return "persona";
  if (path.startsWith("/config/defaults/")) return "model";
  return "advanced";
}
export const groupPaths = (group: Group, paths: readonly string[]) => paths.filter(path => fieldGroup(path) === group);

export function dirtyGroups(changes: Record<string, unknown>, bindings: unknown[] | undefined, tools?: number[]): Set<Group> {
  const dirty = new Set(Object.keys(changes).map(fieldGroup));
  if (bindings !== undefined || tools !== undefined) dirty.add("skills");
  return dirty;
}
export const changeCount = (changes: Record<string, unknown>, bindings: unknown[] | undefined, tools?: number[]) =>
  Object.keys(changes).length + (bindings === undefined ? 0 : 1) + (tools === undefined ? 0 : 1);

export function avatarUrl(value: unknown): string {
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; }
}
const gradients = ["var(--grad-teal-indigo)", "var(--grad-brand)", "linear-gradient(135deg, var(--amber-400), var(--rose-400))",
  "linear-gradient(135deg, var(--cyan-400), var(--indigo-500))", "linear-gradient(135deg, var(--emerald-400), var(--teal-600))",
  "linear-gradient(135deg, var(--violet-400), var(--indigo-600))"];
export const avatarGradient = (id: number) => gradients[Math.abs(id) % gradients.length];
export const initial = (name: string) => [...(name.trim() || "?")][0]!.toLocaleUpperCase();

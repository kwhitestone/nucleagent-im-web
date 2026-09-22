// Vendored from `@prism-fusion/plugin-runtime` — see VENDORED.md.
//
// Source: kwhitestone/prism-fusion @ 45d6fc57545443e4055cf20b393720a597c1a854,
//         src/web/src/plugin/remote-registry.ts (pkg v2.1.0)
//
// This is a *minimal* extract: only the two types and the one validator that
// `remote-channel.ts`'s child channel needs. The rest of upstream's
// remote-registry (RemoteApplicationRegistry, validateRemoteApplication,
// asPlugin) is host-side and imports `vue-router`, which im-web does not
// depend on. `validateMessageCapabilities` below is copied verbatim.

export interface RemoteMessageCapabilities {
  toChild: string[];
  fromChild: string[];
}

export function validateMessageCapabilities(value: RemoteMessageCapabilities): void {
  if (!value || typeof value !== "object") throw new Error("Remote messages must declare capabilities");
  for (const direction of ["toChild", "fromChild"] as const) {
    const names = value[direction];
    if (!Array.isArray(names) || names.length > 128 || names.some(name =>
      typeof name !== "string" || !/^[a-z][a-z0-9.-]{0,63}$/.test(name)
    ) || new Set(names).size !== names.length) {
      throw new Error(`Invalid remote message capabilities: ${direction}`);
    }
  }
}

# Vendored: `@prism-fusion/plugin-runtime` (child-channel subset)

im-web runs as an iframe child of the `nucleagent-web` shell and speaks the
shell's `prism-fusion/remote` protocol. The protocol implementation is vendored
rather than added as a dependency, following the precedent set by
`nucleagent-core-web/src/vendor/prism-fusion-plugin-runtime/VENDORED.md`.

## Provenance

| | |
|---|---|
| Upstream repository | `kwhitestone/prism-fusion` |
| Upstream path | `src/web/src/plugin` |
| Upstream commit | `45d6fc57545443e4055cf20b393720a597c1a854` |
| Package name | `@prism-fusion/plugin-runtime` |
| Package version | `2.1.0` |
| Vendored on | 2026-09-22 |

## What is vendored — and why so little

Two files, both child-side only:

```
remote-channel.ts     remote-registry.ts
```

core-web vendors all 10 production files because it is a full plugin host.
im-web is **only** a remote child: it needs `createRemoteChildChannel` and
nothing else. Upstream's `remote-channel.ts` imports two symbols from
`remote-registry.ts`, and the second one (`validateRemoteApplication`) pulls in
`vue-router` via `createRouterMatcher`. im-web has no `vue-router` dependency
and adding one to be an iframe child would be backwards, so:

- `remote-channel.ts` — verbatim **minus** `createRemoteHostChannel` and
  `RemoteHostChannelOptions` (host-side; the only users of
  `validateRemoteApplication`). `createRemoteChildChannel`, the envelope guard,
  and the `message()` builder are unmodified, so the wire format is
  bit-identical to the shell's host channel.
- `remote-registry.ts` — a minimal extract: `RemoteMessageCapabilities` and
  `validateMessageCapabilities` (copied verbatim), which is all the child
  channel calls. No `vue-router` import, no registry, no host validation.

Relative imports use the `./x.ts` extension rather than upstream's `./x.js`
because `node --experimental-strip-types` runs these modules directly under
`npm test` (same reason as the rest of `src/`, see `tsconfig.json`).

## Updating

Do not hand-edit. To take a newer upstream revision, re-extract the child half
of `remote-channel.ts` plus `validateMessageCapabilities`, keep the header
comments, update the rows above, and run `npm test` — `tests/shell-bridge.test.ts`
exercises the handshake and the origin/version/appId rejection paths.

Local modifications: the two omissions and the import extensions described
above. No logic changes.

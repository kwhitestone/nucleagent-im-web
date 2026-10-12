# nucleagent-im-web

Vue 3 chat frontend for NucleAgent's WuKongIM v3 subsystem.

```bash
npm ci
npm run dev
```

The dev server listens on `http://127.0.0.1:26656`. The browser entry needs
HTTPS and a same-origin `/runtime-config.json` (as core-web): endpoints are no
longer baked from `.env` and never fall back to localhost. Debug locally behind
an HTTPS reverse proxy on a development hostname that serves the same file.

## Runtime configuration

One image serves every environment; it takes no `VITE_*` build args. At
container start `docker-entrypoint.d/40-runtime-config.sh` writes these public
values (and nothing else from the environment) to `/runtime-config.json`; the
browser validates them against its own origin and environment before the app
and the IM SDK initialize. Secrets, API keys and user credentials never belong
here.

| Variable | Required | Value |
| --- | --- | --- |
| `VITE_AUTH_BASE` | yes | `https://nucleagent-auth.<env>.ndaeweb.com` |
| `VITE_IM_BASE` | yes | `https://nucleagent-im.<env>.ndaeweb.com` |
| `VITE_CORE_BASE` | yes | `https://nucleagent-core-web.<env>.ndaeweb.com` |
| `VITE_SHELL_URL` | yes | `https://nucleagent-web.<env>.ndaeweb.com` |
| `VITE_ACCOUNT_UI_URL` | yes, may be empty | `<shell>/remote/account-ui.js`; empty shows the minimal identity card |
| `VITE_SHELL_ALLOWED_ORIGINS` | no | see below |

Endpoints must be public HTTPS origins in the page's own environment; a
missing, loopback, cross-environment or malformed value fails the container
start, and the page shows an alert instead of mounting. On the outer PROD
domain the inner values are mapped to their outer twins (`outerHost.ts`).

Login credentials are exchanged for `data.accessToken`, then the app requests
`/api/v1/im/connect-token` and connects the SDK with `uid`, `token`, and
`wsAddr`. Access credentials remain in memory.


### Additional shell origins

`VITE_SHELL_ALLOWED_ORIGINS` is a runtime comma-separated allowlist for
embedded shell messages. Omitted or empty preserves `VITE_SHELL_URL` as the
single trusted shell. The child binds replies to the verified parent origin;
parent, protocol, app, instance and session validation still apply.

At container start, `FRAME_ANCESTORS` accepts comma-separated exact HTTP(S)
origins. Omitted preserves `SHELL_ORIGIN` (default `VITE_SHELL_URL`); explicit empty or invalid entries
fail startup. Preserve the existing production origin when adding clients,
and restart the container when changing the message allowlist.

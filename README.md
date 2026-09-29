# nucleagent-im-web

Vue 3 chat frontend for NucleAgent's WuKongIM v3 subsystem.

```bash
npm ci
npm run dev
```

The app listens on `http://127.0.0.1:26656`.

| Variable | Default |
| --- | --- |
| `VITE_AUTH_BASE` | `http://127.0.0.1:26670` |
| `VITE_IM_BASE` | `http://127.0.0.1:26655` |

Login credentials are exchanged for `data.accessToken`, then the app requests
`/api/v1/im/connect-token` and connects the SDK with `uid`, `token`, and
`wsAddr`. Access credentials remain in memory.


### Additional shell origins

`VITE_SHELL_ALLOWED_ORIGINS` is a build-time comma-separated allowlist for
embedded shell messages. Omitted or empty preserves `VITE_SHELL_URL` as the
single trusted shell. The child binds replies to the verified parent origin;
parent, protocol, app, instance and session validation still apply.

At container start, `FRAME_ANCESTORS` accepts comma-separated exact HTTP(S)
origins. Omitted preserves `SHELL_ORIGIN`; explicit empty or invalid entries
fail startup. Preserve the existing production origin when adding clients,
and rebuild the frontend when changing the message allowlist.

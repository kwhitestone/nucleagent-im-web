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

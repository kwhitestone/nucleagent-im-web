# nucleagent-im-web

Vue 3 and Vite chat frontend for the NucleAgent WuKongIM subsystem.

## Development

```bash
npm ci
npm run dev
```

The development server uses fixed port `26656`.

## Environment

- `VITE_AUTH_BASE`: auth service base URL, default `http://127.0.0.1:26670`
- `VITE_IM_BASE`: IM API base URL, default `http://127.0.0.1:26655`

## Verification

Before committing, run the self-check three:

1. `npm test`
2. `npm run build`
3. Start `npm run dev` and verify the login view on port `26656`

All commit messages must be English Conventional Commits.

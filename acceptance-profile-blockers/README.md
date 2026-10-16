# Profile Blockers Verification

This is a local **MOCK** fixture: real SearchPanel, ContactPicker, accountPopover
and both real shell profile-card modules, with intercepted synthetic HTTP data.
The App search-exit watcher is extracted from its TypeScript AST and executed,
not copied into the fixture. This is not a full signed-in App or deployment test.

Place the IM checkout at `<root>/web`, old-contract shell at `<root>/shell`,
and host-contract shell at `<root>/shell-host`. Existing dependencies must be
installed in each checkout; Playwright Chromium must be available.

```sh
node acceptance-profile-blockers/build.mjs
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node acceptance-profile-blockers/browser.mjs
PLAYWRIGHT_PATH=/path/to/node_modules/playwright node acceptance-profile-blockers/dev-smoke.mjs
```

Run serially with the coordinator's load/timeout gate. Results go to
`<root>/runs/browser.json`, screenshots to `<root>/shots`. All routes are
intercepted, no live credentials or users are used, and no server is left running.
Retry checks advance Playwright's virtual clock instead of sleeping.
The login smoke owns local Vite port 27338, proxies its assets into an intercepted
HTTPS page origin to satisfy the unchanged runtime namespace contract, mocks
auth refusal, and blocks WebSockets. It never submits login credentials.

Coverage: native forward/backward keyboard traversal (never JS-focus the
profile button), mouse/touch identity targeting, Esc focus return, cold exit,
same-target reopen, latest-target/repeated trigger and cross-surface ordering,
explicit HTTP/network/malformed/missing states, manual retry, preserved query,
page, scroll and selection, optional host fallback and shared unmount.

Deployment, signed-session propagation, production policy and full GroupDialog
end-to-end remain separate acceptance gates. The historical acde27b is not
approved by these tests.

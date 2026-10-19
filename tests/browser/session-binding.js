import { createApp, nextTick } from "vue";
import { loadRuntimeConfig } from "../../src/runtimeConfig";
import "../../src/style.css";
import "../../src/styles/aurora.css";

await loadRuntimeConfig("https://im.fixture.test", async () => new Response(JSON.stringify({
  VITE_AUTH_BASE: "https://auth.fixture.test", VITE_IM_BASE: "https://api.fixture.test",
  VITE_CORE_BASE: "https://core.fixture.test", VITE_SHELL_URL: "https://shell.fixture.test",
  VITE_SHELL_ALLOWED_ORIGINS: "", VITE_ACCOUNT_UI_URL: "",
})));
let generation = 1, deny = false, hold = false;
const calls = [], pending = [];
const jwt = () => `synthetic.${btoa(JSON.stringify({ userId: "fixture-self", generation }))}.unsigned`;
const response = (data, status = 200) => new Response(JSON.stringify({
  code: status === 200 ? 0 : 1, message: status === 200 ? "" : "fixture_denied", data,
}), { status, headers: { "Content-Type": "application/json" } });
window.fetch = async (input, init) => {
  const path = new URL(String(input), location.href).pathname;
  const fresh = new Headers(init?.headers).get("Authorization") === jwt();
  const record = { path, generation, fresh, status: 0 };
  calls.push(record);
  if (path.endsWith("/refresh-token")) { record.status = 401; return response({}, 401); }
  const sync = /\/conversation\/list$|\/channel\/messagesync$/.test(path);
  const data = path.endsWith("/conversation/list") ? { conversations: [], done: true }
    : path.endsWith("/messagesync") ? { messages: [] }
    : path.endsWith("/directory/resolve") ? { items: [], degraded: false }
    : path.endsWith("/agents/catalog") ? { capabilities: { read: false }, items: [] }
    : path.endsWith("/user-info") ? { id: "fixture-self", roles: [] } : [];
  if (sync && hold) return new Promise(resolve => pending.push({
    signal: init?.signal,
    finish(status) { record.status = status; resolve(response(data, status)); },
  }));
  record.status = sync && (!fresh || deny) ? 401 : 200;
  return response(data, record.status);
};
const [{ default: App }, { default: i18n }, { Channel, WKSDK }] = await Promise.all([
  import("../../src/App.vue"), import("../../src/i18n"), import("wukongimjssdk"),
]);
const app = createApp(App).use(i18n);
app.mount("#app");
await nextTick();
const state = app._instance.setupState;
const port = new URLSearchParams(location.search).get("socketPort");
window.fixture = {
  calls,
  async start() {
    state.startSession({ uid: "fixture-self", jwt: jwt(), token: "synthetic-im", wsAddr: `ws://127.0.0.1:${port}` });
    state.activeChannel = new Channel("fixture-peer", 1);
    state.draft = "synthetic unsent draft";
    await nextTick();
  },
  async renew() { generation++; await state.adoptShellSession(jwt()); await nextTick(); },
  async sweep() { await Promise.all([state.syncConversations(), state.refreshActiveHistory()]); },
  hold() { hold = true; },
  release(status) { hold = false; for (const p of pending.splice(0)) p.finish(status); },
  unhold() { hold = false; },
  deny(value) { deny = value; },
  snapshot() { return { generation, connection: state.connection, error: state.loginError,
    messages: state.messages.length, conversations: state.conversations.length,
    draft: state.draft, pending: pending.length,
    aborted: pending.filter(p => p.signal?.aborted).length,
    sdkUidMatches: WKSDK.shared().config.uid === state.session?.uid }; },
  stop() { app.unmount(); },
};

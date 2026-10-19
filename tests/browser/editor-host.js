import { createApp, nextTick } from "vue";
import { loadRuntimeConfig } from "../../src/runtimeConfig";
import "../../src/styles/aurora.css";
import "../../src/style.css";
import "@prism-fusion/editor-ui/style.css";

await loadRuntimeConfig("https://im.editor.test", async () => new Response(JSON.stringify({
  VITE_AUTH_BASE: "https://auth.editor.test", VITE_IM_BASE: "https://api.editor.test",
  VITE_CORE_BASE: "https://core.editor.test", VITE_SHELL_URL: "https://shell.editor.test",
  VITE_SHELL_ALLOWED_ORIGINS: "", VITE_ACCOUNT_UI_URL: "",
})));
const calls = [];
const real = new URLSearchParams(location.search).has("real");
const socketPort = new URLSearchParams(location.search).get("socketPort") ?? "5473";
const capabilities = { read: true, write: true, writeIdentity: true, delete: true, restore: true,
  readSkills: true, writeSkillBindings: true, readTools: true, writeTools: true, create: true };
const fieldPolicy = { editablePaths: ["/name", "/config/description"], readOnlyPaths: [],
  protectedPaths: [], unknownPaths: [], reasons: {} };
const definition = { id: 9001, name: "Synthetic Agent", slug: "synthetic-agent", revision: "1",
  isActive: true, config: { description: "Synthetic fixture only", defaults: { providerId: 1, model: "synthetic-model" } } };
let uncertain = false;
const aggregate = () => ({ definition, capabilities, fieldPolicy, skillBindings: [], skills: [], tools: [],
  effective: { revision: definition.revision, definitionRevision: definition.revision }, identity: { uid: null, status: "ready" } });
// No original fetch fallback: all external traffic is intercepted.
const localFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (String(url).startsWith(`http://127.0.0.1:${socketPort}/`)) return localFetch(url, init);
  const path = new URL(String(url), location.href).pathname;
  const method = init?.method ?? "GET";
  calls.push({ path, method });
  if (real && new URL(String(url), location.href).origin === "https://core.editor.test") {
    const target = new URL(String(url));
    return localFetch(`${target.pathname}${target.search}`, init);
  }
  let data = [], status = 200;
  if (method === "PATCH" && path.endsWith("/agents/9001")) {
    if (uncertain) throw new TypeError("Synthetic connection lost after write dispatch");
    if (new Headers(init.headers).get("If-Match") !== `"agent-9001-${definition.revision}"`) status = 412;
    else {
      for (const [key, value] of Object.entries(JSON.parse(init.body).changes ?? {})) {
        if (!fieldPolicy.editablePaths.includes(key)) throw Error("Synthetic forbidden field");
        if (key === "/name") definition.name = value;
        else if (key === "/config/description") definition.config.description = value;
      }
      definition.revision = String(Number(definition.revision) + 1);
      data = aggregate();
    }
  } else if (path.endsWith("/refresh-token")) status = 401;
  else if (path.endsWith("/agents/catalog")) data = { capabilities, fieldPolicy, skills: [] };
  else if (path.endsWith("/admin/agents")) data = [definition];
  else if (path.endsWith("/agents/9001")) data = aggregate();
  else if (path.endsWith("/agents/9001/impact")) data = { instances: 0, conversations: 0, conversations_7d: 0,
    skill_bindings: 0, im_groups: 0, deliverables: 0, unavailable: [], counted_at: "2026-10-19T00:00:00Z" };
  else if (path.endsWith("/agents/events")) data = { events: [], nextCursor: "0", hasMore: false };
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 401, data, typesAvailable: true,
    page: 1, pageSize: 20, total: Array.isArray(data) ? data.length : 0, hasMore: false }), {
    status, headers: { "Content-Type": "application/json", etag: `"agent-9001-${definition.revision}"` },
  });
};
const { default: App } = await import("../../src/App.vue");
const { default: i18n } = await import("../../src/i18n");
const { Channel } = await import("wukongimjssdk");
const app = createApp(App).use(i18n);
app.mount("#app");
await nextTick();
const state = app._instance.setupState;
window.editorHostFixture = {
  calls,
  uncertain: () => { uncertain = true; },
  saved: () => ({ name: definition.name, revision: definition.revision }),
  renew: (uid = "synthetic-self") => state.adoptShellSession(`synthetic.${btoa(JSON.stringify({ userId: uid }))}.unsigned`),
  revoke: () => { state.canManageAgents = false; },
  connection: () => state.connection,
  async start() {
    state.startSession({ uid: "synthetic-self", jwt: "synthetic-only", token: "synthetic-only", wsAddr: `ws://127.0.0.1:${socketPort}` });
    await nextTick();
    state.canManageAgents = true;
    state.activeChannel = new Channel("synthetic-peer", 1);
    state.draft = "Synthetic unsent draft";
  },
  seed() {
    // Test-only component seeding is not a login/socket acceptance proof.
    state.session = { uid: "synthetic-self", jwt: "synthetic-only", token: "synthetic-only", wsAddr: "wss://socket.editor.test" };
    state.canManageAgents = true;
    state.profileName = "Synthetic account";
    state.activeChannel = new Channel("synthetic-peer", 1);
    state.draft = "Synthetic unsent draft";
  },
};

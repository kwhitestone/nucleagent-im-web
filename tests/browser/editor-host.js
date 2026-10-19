import { createApp, nextTick } from "vue";
import { loadRuntimeConfig } from "../../src/runtimeConfig";
import "../../src/styles/aurora.css";
import "../../src/style.css";

await loadRuntimeConfig("https://im.editor.test", async () => new Response(JSON.stringify({
  VITE_AUTH_BASE: "https://auth.editor.test", VITE_IM_BASE: "https://api.editor.test",
  VITE_CORE_BASE: "https://core.editor.test", VITE_SHELL_URL: "https://shell.editor.test",
  VITE_SHELL_ALLOWED_ORIGINS: "", VITE_ACCOUNT_UI_URL: "",
})));
const calls = [];
const capabilities = { read: true, write: true, writeIdentity: true, delete: true, restore: true,
  readSkills: true, writeSkillBindings: true, readTools: true, writeTools: true, create: true };
const fieldPolicy = { editablePaths: ["/name", "/config/description"], readOnlyPaths: [],
  protectedPaths: [], unknownPaths: [], reasons: {} };
const definition = { id: 9001, name: "Synthetic Agent", slug: "synthetic-agent", revision: "1",
  isActive: true, config: { description: "Synthetic fixture only", defaults: { providerId: 1, model: "synthetic-model" } } };
// No original fetch fallback: all external traffic is intercepted.
window.fetch = async (url, init) => {
  const path = new URL(String(url), location.href).pathname;
  calls.push({ path, method: init?.method ?? "GET" });
  let data = [], status = 200;
  if (path.endsWith("/refresh-token")) status = 401;
  else if (path.endsWith("/agents/catalog")) data = { capabilities, fieldPolicy, skills: [] };
  else if (path.endsWith("/admin/agents")) data = [definition];
  else if (path.endsWith("/agents/9001")) data = { definition, capabilities, fieldPolicy, skillBindings: [], skills: [], tools: [],
    effective: { revision: "1", definitionRevision: "1" }, identity: { uid: null, status: "ready" } };
  else if (path.endsWith("/agents/events")) data = { events: [], nextCursor: "0", hasMore: false };
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 401, data, typesAvailable: true }), {
    status, headers: { "Content-Type": "application/json", etag: '"agent-9001-1"' },
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
  seed() {
    // Test-only component seeding is not a login/socket acceptance proof.
    state.session = { uid: "synthetic-self", jwt: "synthetic-only", token: "synthetic-only", wsAddr: "wss://socket.editor.test" };
    state.canManageAgents = true;
    state.profileName = "Synthetic account";
    state.activeChannel = new Channel("synthetic-peer", 1);
    state.draft = "Synthetic unsent draft";
  },
};

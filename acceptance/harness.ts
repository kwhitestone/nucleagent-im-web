// IM-GROUP-BLOCKERS-FIX-NOW local acceptance (not shipped): the real GroupDialog + the shared
// account-ui card built from nucleagent-web feat/profile-card-host (the acceptance script serves it at
// the DEV account-ui URL via CDP Fetch interception),
// IM/auth answered from test data; mutable server state for save scenarios. ?n=2|30|80
import { loadRuntimeConfig } from "../src/runtimeConfig.ts";
import { runtimeFixture } from "../tests/fixtures/runtimeConfig.ts";

const n = Number(new URLSearchParams(location.search).get("n") || 30);
const group = { id: 8, creatorUid: 1, title: `测试群-${n}人`, wukongChannelId: "group_8" };
const human = (uid: number) => ({ uid, username: `tester${uid}`, displayName: `测试成员${uid}`, avatar: "", accountType: "human" });
const bot = (uid: number, name: string) => ({ uid, username: `bot${uid}`, displayName: name, avatar: "", accountType: "agent" });
// n = total members: owner + agent A, then (n >= 3) agent B, then people from uid 100.
let members = [human(1), bot(37, "测试智能体A"), ...(n >= 3 ? [bot(38, "测试智能体B")] : []),
  ...Array.from({ length: Math.max(0, n - 3) }, (_, i) => human(100 + i))];
const allow: Record<number, number[]> = ((window as any).__allow = { 37: [], 38: [] });
const fail: Set<number> = ((window as any).__failPut = new Set());
(window as any).__leave = (uid: number) => { members = members.filter((m) => m.uid !== uid); for (const k in allow) allow[k] = allow[k].filter((u) => u !== uid); };
const log: string[] = ((window as any).__calls = []);
const realFetch = window.fetch.bind(window);
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } });
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  const method = init?.method ?? "GET";
  if (url.includes("/remote/account-ui")) return realFetch(input, init);
  log.push(`${method} ${new URL(url).pathname}`);
  const del = url.match(/\/groups\/8\/members\/(\d+)$/);
  if (del && method === "DELETE") { members = members.filter((m) => m.uid !== Number(del[1])); return json(null); }
  if (url.endsWith("/groups/8/members") && method === "POST") {
    const ids: number[] = JSON.parse(String(init!.body)).memberUids;
    members = [...members, ...ids.map(human)]; return json({ group, members });
  }
  if (url.endsWith("/groups/8/members")) return json({ group, members });
  const al = url.match(/\/agents\/(\d+)\/allowlist$/);
  if (al) {
    const a = Number(al[1]);
    if (method === "PUT") {
      if (fail.has(a)) return new Response(JSON.stringify({ code: 1, message: "im_unavailable" }), { status: 503 });
      const uids: number[] = JSON.parse(String(init!.body)).memberUids;
      if (uids.some((u) => !members.some((m) => m.uid === u))) return new Response(JSON.stringify({ code: 1, message: "member_not_found" }), { status: 404 });
      allow[a] = [...uids];
    }
    return json({ agentUid: a, memberUids: allow[a] ?? [], ownerImplicit: true });
  }
  if (url.includes("/directory/resolve")) {
    // Test profiles for test members, so the card is the real identity body, not the "no such account" one.
    const uids: number[] = JSON.parse(String(init?.body ?? "{}")).uids ?? [];
    return json({ degraded: false, items: uids.map((uid) => { const m = members.find((x) => x.uid === uid);
      return { uid, profile: m ? { nickName: m.displayName, avatar: "", accountType: m.accountType, provisioned: true, username: m.username, enterprise: false, openId: null } : null }; }) });
  }
  if (url.includes("/directory") || url.includes("/contacts/search"))
    return json({ items: Array.from({ length: 12 }, (_, i) => ({ id: 500 + i, username: `cand${i}`, displayName: `候选人${i}`, accountType: "human", provisioned: true })), hasMore: false, nextCursor: "", degraded: false, page: 1 });
  return json({});
};

await loadRuntimeConfig("https://nucleagent-im-web.dev.ndaeweb.com",
  (async () => new Response(JSON.stringify(runtimeFixture()))) as typeof fetch);
const [{ createApp, h, ref }, { default: i18n }, { default: GroupDialog }, ap] = await Promise.all([
  import("vue"), import("../src/i18n"), import("../src/components/GroupDialog.vue"), import("../src/accountPopover.ts")]);
await import("../src/styles/aurora.css"); await import("../src/style.css");

const session = { uid: "1", token: "test", wsAddr: "ws://127.0.0.1:1", jwt: "test-jwt" };
const open = ref(true);
const events: string[] = ((window as any).__events = []);
const accountUi = ap.useAccountPopover();
// Same wiring as App.vue openProfile for the group-panel entry.
function openProfile(anchor: HTMLElement, target: any) {
  const can = ap.profileActions(target, { selfUid: session.uid, inGroup: open.value });
  (window as any).__can = can;
  void accountUi.openProfile(anchor, ap.profileParams(session as any, "zh", {
    uid: target.uid, known: target.known, host: target.host,
    onMessage: can.message ? () => events.push("message") : undefined,
    onAddToGroup: can.addToGroup ? () => { events.push("addToGroup"); open.value = false; } : undefined,
  }));
}
createApp({ render: () => h("main", { class: "app-shell" }, [
  h("button", { id: "reopen", onClick: () => (open.value = true) }, "打开群面板"),
  open.value ? h(GroupDialog, { session, group, directoryAgents: [],
    onClose: () => { events.push("close"); open.value = false; }, onProfile: openProfile, onChanged: () => events.push("changed") }) : null,
]) }).use(i18n).mount("#app");

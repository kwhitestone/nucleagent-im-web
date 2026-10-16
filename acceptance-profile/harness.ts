// IM-SEARCH-PROFILE-INTERACTION local acceptance (not shipped). MOCK: every IM/auth answer below is
// synthetic test data (no real account, no real user); the real SearchPanel, ContactPicker and the real
// shared account-ui card (nucleagent-web main, served at the DEV account-ui URL by the CDP script).
import { loadRuntimeConfig } from "../src/runtimeConfig.ts";
import { runtimeFixture } from "../tests/fixtures/runtimeConfig.ts";

const person = (id: number, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, portalUid: id + 1000, username: `mock${id}`, displayName: name, accountType: "human", provisioned: true, phoneMasked: null, openId: `nduc_mock_${id}`, ...extra });
// 14 and 15 share a name (enterprise vs SMS); 16 resolves to nothing; 17 makes resolve fail (5xx).
const people = [person(14, "测试林雨"), person(15, "测试林雨", { phoneMasked: "138****0001" }), person(16, "测试无资料"), person(17, "测试加载失败"),
  ...Array.from({ length: 20 }, (_, i) => person(100 + i, `测试成员${i}`))];
const w = window as any;
const log: string[] = (w.__calls = []);
w.__limit = false; // next directory search answers 429
w.__resolveDelay = 0;
const realFetch = window.fetch.bind(window);
const json = (data: unknown) => new Response(JSON.stringify({ code: 0, data }), { headers: { "content-type": "application/json" } });
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes("/remote/account-ui")) return realFetch(input, init);
  const u = new URL(url);
  log.push(`${init?.method ?? "GET"} ${u.pathname}${u.search}`);
  if (url.includes("/directory/resolve")) {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const ids: number[] = body.uids ?? (body.openIds ?? []).map((o: string) => Number(o.replace("nduc_mock_", "")));
    if (w.__resolveDelay) await new Promise((r) => setTimeout(r, w.__resolveDelay));
    if (ids.includes(17)) return new Response(JSON.stringify({ code: 1, message: "mock 503" }), { status: 503 });
    return json({ degraded: false, items: ids.map((id) => { const p = people.find((x) => x.id === id && id !== 16);
      return { uid: id, profile: p ? { nickName: p.displayName, avatar: "", accountType: "human", provisioned: true, username: p.username, enterprise: p.phoneMasked === null, openId: p.openId } : null }; }) });
  }
  if (url.includes("/directory/search")) {
    if (w.__limit) return new Response(JSON.stringify({ code: 429, message: "mock rate limited" }), { status: 429 });
    const q = u.searchParams.get("q") ?? "";
    const page = Number(u.searchParams.get("page") || 1);
    const hits = people.filter((p) => !q || p.displayName.startsWith(q));
    const size = 6;
    return json({ items: hits.slice((page - 1) * size, page * size), page, hasMore: hits.length > page * size, degraded: false, nextCursor: "" });
  }
  if (url.includes("/im/search")) return new Response(JSON.stringify({ messages: [], total: 0, next_cursor: "" }), { headers: { "content-type": "application/json" } });
  return json({ items: [] });
};

await loadRuntimeConfig("https://nucleagent-im-web.dev.ndaeweb.com", (async () => new Response(JSON.stringify(runtimeFixture()))) as typeof fetch);
const [{ createApp, h, ref }, { default: i18n }, { default: SearchPanel }, { default: ContactPicker }, ap] = await Promise.all([
  import("vue"), import("../src/i18n"), import("../src/components/SearchPanel.vue"), import("../src/components/ContactPicker.vue"), import("../src/accountPopover.ts")]);
await import("../src/styles/aurora.css"); await import("../src/style.css");

const session = { uid: "1", token: "mock", wsAddr: "ws://127.0.0.1:1", jwt: "mock-jwt" };
const events: string[] = (w.__events = []);
const accountUi = ap.useAccountPopover();
const toast = ref("");
// Same wiring as App.vue openProfile (select-only for picker rows, message for search rows).
function openProfile(anchor: HTMLElement, target: any) {
  events.push(`profile:${target.uid || target.openId}`);
  const can = ap.profileActions(target, { selfUid: session.uid });
  void accountUi.openProfile(anchor, ap.profileParams(session as any, i18n.global.locale.value as "zh" | "en", {
    uid: target.uid, openId: target.openId, known: target.known,
    onSelect: can.select ? target.select : undefined,
    onMessage: can.message ? () => events.push(`card-message:${target.uid}`) : undefined,
  })).then((shown) => { if (!shown) toast.value = i18n.global.t("profile.unavailable"); });
}
const view = new URLSearchParams(location.search).get("view") || "search";
const selected = ref<any[]>([]);
w.__selected = selected;
createApp({ render: () => h("main", { class: "app-shell", style: "display:block" }, [
  h("p", { style: "margin:0;padding:4px 8px;background:#fde68a;font:12px monospace", "data-mock": "1" }, "MOCK 数据：本页 IM/auth 接口均为合成测试数据"),
  view === "search"
    ? h("aside", { class: "sidebar", style: "height:calc(100dvh - 24px);max-width:420px" }, [h(SearchPanel, { session, conversations: [], hiddenKeys: new Set(), agents: [], titleFor: () => "",
      onClose: () => events.push("close"), onContact: (e: any) => events.push(`contact:${e.id}`), onProfile: openProfile })])
    : h("div", { style: "padding:12px;max-width:480px" }, [h(ContactPicker, { session, multiple: true, modelValue: selected.value,
      "onUpdate:modelValue": (v: any[]) => { selected.value = v; events.push(`picked:${v.map((c) => c.id).join(",")}`); }, onProfile: openProfile })]),
  toast.value ? h("p", { class: "toast", role: "alert" }, toast.value) : null,
]) }).use(i18n).mount("#app");

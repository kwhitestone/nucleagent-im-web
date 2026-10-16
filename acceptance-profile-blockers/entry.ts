import { loadRuntimeConfig } from "WEB/src/runtimeConfig.ts";
import { runtimeFixture } from "WEB/tests/fixtures/runtimeConfig.ts";
import bindExit from "actual-search-exit";
import "WEB/src/styles/aurora.css";
import "WEB/src/style.css";

await loadRuntimeConfig("https://nucleagent-im-web.dev.ndaeweb.com",
  (async () => new Response(JSON.stringify(runtimeFixture()))) as typeof fetch);
const [{ createApp, h, ref }, { default: i18n }, { default: SearchPanel }, { default: ContactPicker }, ap] =
  await Promise.all([import("vue"), import("WEB/src/i18n/index.ts"),
    import("WEB/src/components/SearchPanel.vue"), import("WEB/src/components/ContactPicker.vue"),
    import("WEB/src/accountPopover.ts")]);
const w = window as any;
const query = new URLSearchParams(location.search);
const locale = query.get("lang") === "en" ? "en" : "zh";
i18n.global.locale.value = locale;
const session = { uid: "1", token: "synthetic", wsAddr: "ws://unused.invalid", jwt: "synthetic" };
const ui = ap.useAccountPopover();
const show = ref(true), selected = ref([{ id: 90, username: "selected", displayName: "Already selected", accountType: "human" }]);
const events: string[] = [];
const toast = ref("");
const open = (anchor: HTMLElement, target: any) => {
  events.push(`profile:${target.uid}`);
  w.review.pending = ui.openProfile(anchor, ap.profileParams(session, locale, {
    uid: target.uid, openId: target.openId, portalUid: target.portalUid, known: target.known,
    onSelect: target.select, host: target.host,
  })).then((available: boolean) => { if (!available) toast.value = i18n.global.t("profile.unavailable"); });
};
w.review = { ui, show, events, selected, open, locale };
const picker = query.get("view") === "picker";
createApp({
  setup() { bindExit(show, ui); },
  render: () => h("main", { style: "max-width:480px;height:850px" }, [
    h("p", { "data-mock": "true" }, "MOCK - isolated component verification"),
    show.value ? (picker ? h(ContactPicker, {
      session, multiple: true, modelValue: selected.value,
      "onUpdate:modelValue": (value: any) => { selected.value = value; events.push("select"); }, onProfile: open,
    }) : h(SearchPanel, {
      session, conversations: [], hiddenKeys: new Set(), agents: [], titleFor: () => "",
      onClose: () => { show.value = false; events.push("close"); },
      onContact: (entry: any) => events.push(`contact:${entry.id}`), onProfile: open,
    })) : h("p", { "data-testid": "closed" }, "Closed"),
    h("button", { id: "other-surface", onClick: (event: MouseEvent) => {
      show.value = false;
      open(event.currentTarget as HTMLElement, { uid: "25" });
    } }, "Other surface"),
    h("div", { id: "profile-host" }),
    toast.value ? h("p", { role: "alert" }, toast.value) : null,
  ]),
}).use(i18n).mount("#app");

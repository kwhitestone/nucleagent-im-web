import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountPopover,
  loadAccountPopover,
  profileActions,
  profileParams,
  type AccountPopoverMount,
  type AccountPopoverParams,
  type LoaderDeps,
  type ProfileCardParams,
} from "../src/accountPopover.ts";

const URL_ = "https://shell.example/remote/account-ui.js";
const params: AccountPopoverParams = {
  user: { nickName: "Chen Mo", headerImg: "", uid: "10480118" },
  locale: "en",
  logout() {},
  manageAccount() {},
};

function fakeDeps(options: { versionStatus?: number; version?: unknown; module?: unknown; importFails?: boolean } = {}) {
  const calls = { fetch: [] as string[], import: [] as string[] };
  const mounted: Array<[unknown, AccountPopoverParams]> = [];
  const api: AccountPopoverMount = {
    mount: (el, p) => { mounted.push([el, p]); },
    unmount: () => { mounted.push(["unmount", params]); },
  };
  const deps: LoaderDeps = {
    async fetch(url) {
      calls.fetch.push(url);
      return options.versionStatus && options.versionStatus !== 200
        ? new Response("", { status: options.versionStatus })
        : Response.json({ version: options.version ?? "63d157dcad38265d" });
    },
    async importModule(url) {
      calls.import.push(url);
      if (options.importFails) throw new TypeError("Failed to fetch dynamically imported module");
      return { default: "module" in options ? options.module : api };
    },
  };
  return { deps, calls, mounted };
}

test("loader reads the version file and imports the module cache-busted with it", async () => {
  const { deps, calls } = fakeDeps();
  const api = await loadAccountPopover(URL_, deps);
  assert.equal(typeof api.mount, "function");
  assert.deepEqual(calls.fetch, ["https://shell.example/remote/account-ui.version.json"]);
  assert.deepEqual(calls.import, [`${URL_}?v=63d157dcad38265d`]);
});

test("loader rejects a missing version, a malformed version, a failed import, and a contract mismatch", async () => {
  await assert.rejects(loadAccountPopover(URL_, fakeDeps({ versionStatus: 404 }).deps), /version 404/);
  await assert.rejects(loadAccountPopover(URL_, fakeDeps({ version: "x?y" }).deps), /malformed/);
  await assert.rejects(loadAccountPopover(URL_, fakeDeps({ importFails: true }).deps), /Failed to fetch/);
  await assert.rejects(loadAccountPopover(URL_, fakeDeps({ module: { mount() {} } }).deps), /contract mismatch/);
});

test("trigger mounts the popover at the element, loading the module once", async () => {
  const { deps, calls, mounted } = fakeDeps();
  const popover = createAccountPopover(URL_, deps);
  const chip = { id: "chip" } as unknown as HTMLElement;
  assert.equal(await popover.open(chip, params), true);
  assert.equal(await popover.open(chip, params), true);
  assert.equal(calls.import.length, 1, "module cached after first load");
  assert.deepEqual(mounted.map(([el]) => el), [chip, chip]);
  assert.equal(mounted[0][1].user.uid, "10480118");
  assert.equal(popover.degraded.value, false);
  popover.close();
  assert.equal(mounted.at(-1)?.[0], "unmount");
});

test("load failure latches the degraded fallback and never throws", async () => {
  const original = console.warn;
  console.warn = () => {};
  try {
    const { deps, calls } = fakeDeps({ importFails: true });
    const popover = createAccountPopover(URL_, deps);
    const chip = {} as HTMLElement;
    assert.equal(await popover.open(chip, params), false);
    assert.equal(popover.degraded.value, true);
    assert.equal(await popover.open(chip, params), false);
    assert.equal(calls.fetch.length, 1, "a down shell costs one request, not one per click");
    popover.close(); // no api: a no-op, not a throw
  } finally {
    console.warn = original;
  }
});

test("no configured URL is degraded from the start and makes no request", async () => {
  const { deps, calls } = fakeDeps();
  const popover = createAccountPopover("", deps);
  assert.equal(popover.degraded.value, true);
  assert.equal(await popover.open({} as HTMLElement, params), false);
  assert.equal(calls.fetch.length, 0);
});

// ---- UNI-IMUX3: the other-person profile card from the same module ----

test("profile card comes from the same module load as the popover (one import)", async () => {
  const { deps, calls } = fakeDeps();
  const cards: Array<[unknown, ProfileCardParams]> = [];
  const card = { mount: (el: unknown, p: ProfileCardParams) => { cards.push([el, p]); }, unmount() {} };
  deps.importModule = async (url) => { calls.import.push(url); return { default: { mount() {}, unmount() {} }, profileCard: card }; };
  const ui = createAccountPopover(URL_, deps);
  const anchor = { id: "sender" } as unknown as HTMLElement;
  const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "Bearer abc" };
  assert.equal(await ui.openProfile(anchor, profileParams(session, "zh", { uid: "14", known: { nickName: "林雨" } })), true);
  assert.equal(await ui.open(anchor, params), true);
  assert.equal(calls.import.length, 1, "popover and card share one module load");
  assert.equal(cards[0][0], anchor);
  assert.equal(cards[0][1].uid, "14");
  assert.equal(cards[0][1].auth.token, "Bearer abc", "resolve runs as this IM session");
  assert.match(cards[0][1].auth.base, /^https?:\/\//, "against im-web's auth base");
});

test("a shell without profileCard (pre-IMUX3) keeps the popover and opens no card", async () => {
  const { deps } = fakeDeps();
  const ui = createAccountPopover(URL_, deps);
  const session = { uid: "1", token: "t", wsAddr: "ws://x", jwt: "j" };
  assert.equal(await ui.openProfile({} as HTMLElement, profileParams(session, "en", { uid: "14" })), false);
  assert.equal(ui.degraded.value, false, "the popover itself still works");
  assert.equal(await ui.open({} as HTMLElement, params), true);
});

test("context actions: picker → Select only; self or portal-only → none; inside that DM → no Message", () => {
  const self = { selfUid: "1" };
  assert.deepEqual(profileActions({ uid: "14", select: () => {} }, self), { select: true, message: false, addToGroup: false });
  assert.deepEqual(profileActions({ uid: "14" }, self), { select: false, message: true, addToGroup: true });
  assert.deepEqual(profileActions({ uid: "14" }, { selfUid: "1", dmUid: "14" }), { select: false, message: false, addToGroup: true });
  assert.deepEqual(profileActions({ uid: "1" }, self), { select: false, message: false, addToGroup: false });
  assert.deepEqual(profileActions({ uid: "" }, self), { select: false, message: false, addToGroup: false });
});

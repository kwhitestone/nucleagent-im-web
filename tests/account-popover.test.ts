import assert from "node:assert/strict";
import test from "node:test";
import {
  createAccountPopover,
  loadAccountPopover,
  type AccountPopoverMount,
  type AccountPopoverParams,
  type LoaderDeps,
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

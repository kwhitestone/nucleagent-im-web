// AccountPopover consumer (UNI-ACCTUI). The popover is owned by the shell
// (nucleagent-web src/account-ui/) and published at <shell>/remote/account-ui.js;
// im-web imports it at runtime so a shell deploy updates it here with no
// im-web rebuild. Types mirror nucleagent-web src/account-ui/contract.ts — the
// single definition; this repo cannot import across repositories.
import { ref, type Ref } from "vue";
import { outerAware } from "./outerHost.ts";

export interface AccountPopoverParams {
  user: { nickName: string; headerImg: string; uid: number | string; roles?: string[] };
  logout: () => Promise<void> | void;
  manageAccount: () => void;
  locale: "zh" | "en";
  theme?: "light" | "dark";
}

export interface AccountPopoverMount {
  mount(el: HTMLElement, params: AccountPopoverParams): void;
  unmount(): void;
}

export interface LoaderDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  importModule: (url: string) => Promise<{ default?: unknown }>;
}

const realDeps: LoaderDeps = {
  fetch: (url, init) => fetch(url, init),
  importModule: (url) => import(/* @vite-ignore */ url),
};

/** Reads the no-cache version file, then imports the immutable module with ?v=<hash>. */
export async function loadAccountPopover(url: string, deps: LoaderDeps = realDeps): Promise<AccountPopoverMount> {
  const response = await deps.fetch(url.replace(/\.js$/, ".version.json"), { cache: "no-cache" });
  if (!response.ok) throw new Error(`account-ui version ${response.status}`);
  const { version } = (await response.json()) as { version?: unknown };
  if (typeof version !== "string" || !/^[0-9a-f]{8,64}$/.test(version)) throw new Error("account-ui version malformed");
  const api = (await deps.importModule(`${url}?v=${version}`)).default as Partial<AccountPopoverMount> | undefined;
  if (typeof api?.mount !== "function" || typeof api.unmount !== "function") throw new Error("account-ui contract mismatch");
  return api as AccountPopoverMount;
}

export interface AccountPopover {
  /** True once loading failed (or no URL is configured): render avatar + name only. */
  degraded: Ref<boolean>;
  /** Opens (or toggles) the popover at `el`; false when degraded. */
  open(el: HTMLElement, params: AccountPopoverParams): Promise<boolean>;
  close(): void;
}

/**
 * One load per page: the first open() fetches, later calls reuse the api.
 * A failure latches `degraded` for the page, so a down shell costs one request,
 * not one per click.
 */
export function createAccountPopover(url: string, deps: LoaderDeps = realDeps): AccountPopover {
  const degraded = ref(!url);
  let api: Promise<AccountPopoverMount> | undefined;
  let loaded: AccountPopoverMount | undefined;
  return {
    degraded,
    async open(el, params) {
      if (degraded.value) return false;
      api ??= loadAccountPopover(url, deps);
      try {
        loaded = await api;
      } catch (error) {
        console.warn("account-ui unavailable; showing the minimal identity card", error);
        degraded.value = true;
        return false;
      }
      loaded.mount(el, params);
      return true;
    },
    close() {
      loaded?.unmount();
    },
  };
}

let shared: AccountPopover | undefined;

/** The app-wide instance, configured by VITE_ACCOUNT_UI_URL (unset: degraded). */
export function useAccountPopover(): AccountPopover {
  shared ??= createAccountPopover(outerAware(import.meta.env?.VITE_ACCOUNT_UI_URL?.trim() || ""));
  return shared;
}

// AccountPopover consumer (UNI-ACCTUI). The popover is owned by the shell
// (nucleagent-web src/account-ui/) and published at <shell>/remote/account-ui.js;
// im-web imports it at runtime so a shell deploy updates it here with no
// im-web rebuild. Types mirror nucleagent-web src/account-ui/contract.ts — the
// single definition; this repo cannot import across repositories.
import { ref, type Ref } from "vue";
import { outerAware } from "./outerHost.ts";
import { authBase, type ConnectSession } from "./api.ts";

export interface AccountPopoverParams {
  user: {
    nickName: string; headerImg: string; uid: number | string; roles?: string[];
    /** UNI-IMUX4 popover rows (board §05): @username and account kind. */
    username?: string; accountType?: "human" | "agent"; enterprise?: boolean;
    /** UNI-PROFILE1 unified card: Agentia Open ID; null = none recorded; omitted = unknown. */
    openId?: string | null;
    /** UNI-PHONESEARCH: masked phone (138****1234); null = none; omitted = unknown. */
    phoneMasked?: string | null;
  };
  logout: () => Promise<void> | void;
  manageAccount: () => void;
  locale: "zh" | "en";
  theme?: "light" | "dark";
}

export interface AccountPopoverMount {
  mount(el: HTMLElement, params: AccountPopoverParams): void;
  unmount(): void;
}

/** The other-person card, the same module's named export `profileCard` (UNI-IMUX3). */
export interface ProfileCardParams {
  /** UNI-OID: the address; precedence openId > uid > portalUid (shell contract). */
  openId?: string;
  uid: number | string;
  portalUid?: number;
  auth: { base: string; token: string };
  locale: "zh" | "en";
  theme?: "light" | "dark";
  known?: { nickName?: string; username?: string; avatar?: string; accountType?: "human" | "agent"; provisioned?: boolean };
  onMessage?: () => void;
  onAddToGroup?: () => void;
  onSelect?: () => void;
}

export interface ProfileCardMount {
  mount(el: HTMLElement, params: ProfileCardParams): void;
  unmount(): void;
}

/** The one bottom-left avatar control (UNI-AVATAR-UNIFY), the same module's named export `avatar`. */
export interface AvatarParams {
  name: string;
  avatarUrl?: string;
  openId?: string;
  uid?: number | string;
  auth?: { base: string; token: string };
}

export interface AvatarMount {
  mount(host: HTMLElement, params: AvatarParams): () => void;
}

/** What a trigger knows about the person; the host adds auth, locale and context actions. */
export interface ProfileTarget {
  /** "" for a not-yet-joined person (then openId, else legacy portalUid). */
  uid: string;
  /** UNI-OID: the person's Open ID when known; agents and local accounts have none (D2). */
  openId?: string;
  portalUid?: number;
  known?: ProfileCardParams["known"];
  /** Picker ⓘ: the card's primary action picks this person. */
  select?: () => void;
}

export interface LoaderDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  importModule: (url: string) => Promise<{ default?: unknown }>;
}

const realDeps: LoaderDeps = {
  fetch: (url, init) => fetch(url, init),
  importModule: (url) => import(/* @vite-ignore */ url),
};

interface AccountUi {
  popover: AccountPopoverMount;
  /** Absent on a shell older than UNI-IMUX3: the card simply does not open. */
  profileCard?: ProfileCardMount;
  /** Absent on a shell older than UNI-AVATAR-UNIFY: the chip keeps its initial. */
  avatar?: AvatarMount;
}

const isMount = (value: unknown): value is { mount: unknown; unmount: unknown } =>
  typeof (value as { mount?: unknown } | undefined)?.mount === "function"
  && typeof (value as { unmount?: unknown }).unmount === "function";

/** Reads the no-cache version file, then imports the immutable module with ?v=<hash>. */
async function loadAccountUi(url: string, deps: LoaderDeps): Promise<AccountUi> {
  const response = await deps.fetch(url.replace(/\.js$/, ".version.json"), { cache: "no-cache" });
  if (!response.ok) throw new Error(`account-ui version ${response.status}`);
  const { version } = (await response.json()) as { version?: unknown };
  if (typeof version !== "string" || !/^[0-9a-f]{8,64}$/.test(version)) throw new Error("account-ui version malformed");
  const module = (await deps.importModule(`${url}?v=${version}`)) as { default?: unknown; profileCard?: unknown; avatar?: unknown };
  if (!isMount(module.default)) throw new Error("account-ui contract mismatch");
  return {
    popover: module.default as AccountPopoverMount,
    profileCard: isMount(module.profileCard) ? module.profileCard as ProfileCardMount : undefined,
    avatar: typeof (module.avatar as { mount?: unknown } | undefined)?.mount === "function" ? module.avatar as AvatarMount : undefined,
  };
}

export async function loadAccountPopover(url: string, deps: LoaderDeps = realDeps): Promise<AccountPopoverMount> {
  return (await loadAccountUi(url, deps)).popover;
}

export interface AccountPopover {
  /** True once loading failed (or no URL is configured): render avatar + name only. */
  degraded: Ref<boolean>;
  /** Opens (or toggles) the popover at `el`; false when degraded. */
  open(el: HTMLElement, params: AccountPopoverParams): Promise<boolean>;
  /** Opens (or toggles) someone else's profile card at `el`; false if unavailable. */
  openProfile(el: HTMLElement, params: ProfileCardParams): Promise<boolean>;
  /** The shared avatar control (same module load); undefined when degraded or the shell predates it. */
  avatar(): Promise<AvatarMount | undefined>;
  close(): void;
}

/**
 * One load per page: the first open() fetches, later calls reuse the api.
 * A failure latches `degraded` for the page, so a down shell costs one request,
 * not one per click.
 */
export function createAccountPopover(url: string, deps: LoaderDeps = realDeps): AccountPopover {
  const degraded = ref(!url);
  let ui: Promise<AccountUi> | undefined;
  let loaded: AccountUi | undefined;
  async function load(): Promise<AccountUi | undefined> {
    if (degraded.value) return undefined;
    ui ??= loadAccountUi(url, deps);
    try {
      return (loaded = await ui);
    } catch (error) {
      console.warn("account-ui unavailable; showing the minimal identity card", error);
      degraded.value = true;
      return undefined;
    }
  }
  return {
    degraded,
    async open(el, params) {
      const api = await load();
      api?.popover.mount(el, params);
      return !!api;
    },
    async openProfile(el, params) {
      const card = (await load())?.profileCard;
      card?.mount(el, params);
      return !!card;
    },
    async avatar() {
      return (await load())?.avatar;
    },
    close() {
      // One layer serves both surfaces, so either unmount closes whichever is open.
      loaded?.popover.unmount();
    },
  };
}

let shared: AccountPopover | undefined;

/** The app-wide instance, configured by VITE_ACCOUNT_UI_URL (unset: degraded). */
export function useAccountPopover(): AccountPopover {
  shared ??= createAccountPopover(outerAware(import.meta.env?.VITE_ACCOUNT_UI_URL?.trim() || ""));
  return shared;
}

/** Card params for a person on screen: resolve runs as this session, against im-web's auth base. */
export function profileParams(
  session: ConnectSession,
  locale: "zh" | "en",
  target: Pick<ProfileCardParams, "openId" | "uid" | "portalUid" | "known" | "onMessage" | "onAddToGroup" | "onSelect">,
): ProfileCardParams {
  return { ...target, auth: { base: authBase, token: session.jwt }, locale };
}

/**
 * Which context actions the card offers (board §03 anno 3). Pure for tests.
 * Picker ⓘ → only "Select". Yourself → none. Inside that very DM → no
 * "Message". UNI-OID: a not-yet-joined person addressed by openId can be
 * messaged (provisioned on click); one with neither uid nor openId cannot.
 */
export function profileActions(
  target: Pick<ProfileTarget, "uid" | "openId" | "select">,
  context: { selfUid: string; dmUid?: string },
): { select: boolean; message: boolean; addToGroup: boolean } {
  if (target.select) return { select: true, message: false, addToGroup: false };
  // An openId-only target is never self: the signed-in user always has a uid row.
  const other = target.uid ? target.uid !== context.selfUid : !!target.openId;
  return {
    select: false,
    message: other && !(target.uid && target.uid === context.dmUid),
    addToGroup: other && !!target.uid,
  };
}

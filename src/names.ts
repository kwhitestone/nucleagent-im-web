// Every person on screen shows their nickName, whether or not they ever used IM
// (user ruling, UNI-IMUX2 2026-09-30). WuKongIM only knows UIDs, so every UID
// the app renders is named through one batched auth call (directory/resolve)
// and cached for the session. Nothing here ever yields a UID: a name that has
// not resolved yet renders as a skeleton, never as the number.
import { reactive } from "vue";
import { NotFound, resolveUsers, type ConnectSession, type ResolvedProfile } from "./api.ts";
import { isPlaceholderName } from "./profile.ts";

// null = resolved, and no account has this uid.
const known = reactive(new Map<string, ResolvedProfile | null>());
const pending = new Set<string>();
const failed = new Set<string>();
let owner = "";
let retry: ReturnType<typeof setTimeout> | undefined;
export const retryMs = 5000;

/** auth's "Portal user N" and random portal_<uuid> usernames are not names. */
export function isRealName(name: string | undefined): name is string {
  const value = name?.trim();
  return !!value && !isPlaceholderName(value) && !value.startsWith("portal_");
}

/** The resolved nickName, else the first real stored name, else "" (= skeleton). */
export function nameFor(uid: string, ...stored: Array<string | undefined>): string {
  const resolved = known.get(uid)?.nickName?.trim();
  if (resolved) return resolved;
  return stored.find(isRealName)?.trim() ?? "";
}

/** True only once the server has said this uid has no account at all. */
export function isMissing(uid: string): boolean {
  return known.get(uid) === null;
}

export function accountTypeOf(uid: string): ResolvedProfile["accountType"] | undefined {
  return known.get(uid)?.accountType;
}

/** The @handle to show: resolved username, else a real stored one; "" for none (never portal_*). */
export function handleFor(uid: string, stored?: string): string {
  const resolved = known.get(uid)?.username;
  const value = resolved !== undefined ? resolved ?? "" : stored ?? "";
  return isRealName(value) ? value.trim() : "";
}

/** The resolved avatar URL, else a stored one (e.g. a group member row); "" = no avatar (initials fallback). */
export function avatarFor(uid: string, stored?: string): string {
  const resolved = known.get(uid)?.avatar;
  return (resolved || stored || "").trim();
}

/** auth's safeAvatar rule (userdirectory/resolve.go): https only, ≤2048 chars, no quotes, brackets or spaces. */
function isSafeAvatar(url: string): boolean {
  return url.startsWith("https://") && url.length <= 2048 && !/[\s"'<>]/.test(url);
}

// IM1 (Q3 A2/A4): uid → the avatar URL whose <img> failed. An <img> error
// carries no status, so any first failure may be an expired signed link: the
// row shows the initial at once, and the uid is re-resolved once (batched with
// every other failure in the window), after which whatever URL it has is drawn
// again. A second image failure stays on the initial for the session — unless
// resolve later hands out a different URL.
const brokenSrc = reactive(new Map<string, string>());
const recheck = new Set<string>();
const rechecked = new Set<string>();
let recheckTimer: ReturnType<typeof setTimeout> | undefined;
let lastSession: ConnectSession | undefined;
export const avatarRetryMs = 300;

/** The avatar to draw: resolved else stored, https only, never the URL that already failed; "" = initial. */
export function avatarSrc(uid: string, stored?: string): string {
  const src = avatarFor(uid, stored);
  return isSafeAvatar(src) && brokenSrc.get(uid) !== src ? src : "";
}

/** An avatar <img> @error: fall back to the initial, and re-resolve the uid once in case the link expired. */
export function avatarFailed(uid: string, src = avatarFor(uid)): void {
  brokenSrc.set(uid, src);
  if (rechecked.has(uid) || !lastSession) return;
  rechecked.add(uid);
  recheck.add(uid);
  recheckTimer ??= setTimeout(() => {
    recheckTimer = undefined;
    const uids = [...recheck];
    recheck.clear();
    if (!lastSession) return;
    void ensureNames(uids, lastSession, true).then(() => uids.forEach((uid) => brokenSrc.delete(uid)));
  }, avatarRetryMs);
}

/** Enterprise (portal-linked) per resolve; undefined when not known (older auth, not resolved yet). */
export function isEnterprise(uid: string): boolean | undefined {
  return known.get(uid)?.enterprise ?? undefined;
}

/** Agentia Open ID per resolve: string, null = none recorded, undefined = not known (older auth, not resolved yet). */
export function openIdOf(uid: string): string | null | undefined {
  return known.get(uid)?.openId;
}

/** UNI-PHONESEARCH: masked phone per resolve; null = none to show, undefined = not known. */
export function phoneMaskedOf(uid: string): string | null | undefined {
  return known.get(uid)?.phoneMasked;
}

/** Sign-out / account switch: one account's names never render in another's session. */
export function resetNames(): void {
  known.clear();
  pending.clear();
  failed.clear();
  owner = "";
  clearTimeout(retry);
  retry = undefined;
  brokenSrc.clear();
  recheck.clear();
  rechecked.clear();
  clearTimeout(recheckTimer);
  recheckTimer = undefined;
  lastSession = undefined;
}

/**
 * Resolves every uid not already known or in flight, in one batched call.
 * Never throws: a failure leaves the names unresolved (skeleton) and retries
 * once per retryMs until it lands. A directory switched off (404) does not retry.
 * `refresh` asks again for uids already known (the avatar recheck); their
 * current profile stays until the new one lands.
 */
export async function ensureNames(uids: Iterable<string>, session: ConnectSession, refresh = false): Promise<void> {
  if (owner !== session.uid) {
    resetNames();
    owner = session.uid;
  }
  lastSession = session;
  const want = [...new Set(uids)].filter(
    (uid) => /^[1-9]\d*$/.test(uid) && (refresh || !known.has(uid)) && !pending.has(uid),
  );
  if (!want.length) return;
  want.forEach((uid) => pending.add(uid));
  try {
    const page = await resolveUsers(want.map(Number), session);
    if (owner !== session.uid) return; // the account changed while this was in flight
    for (const item of page.items) {
      const uid = String(item.uid);
      // Degraded = the portal was unreachable, so a placeholder is not their
      // real name yet: leave it unresolved and ask again.
      if (item.profile && page.degraded && !isRealName(item.profile.nickName)) failed.add(uid);
      else known.set(uid, item.profile);
    }
  } catch (error) {
    if (!(error instanceof NotFound)) want.forEach((uid) => failed.add(uid));
  } finally {
    want.forEach((uid) => pending.delete(uid));
  }
  if (failed.size && owner === session.uid && !retry) {
    retry = setTimeout(() => {
      retry = undefined;
      const again = [...failed];
      failed.clear();
      void ensureNames(again, session);
    }, retryMs);
  }
}

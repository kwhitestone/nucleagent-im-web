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

/** Sign-out / account switch: one account's names never render in another's session. */
export function resetNames(): void {
  known.clear();
  pending.clear();
  failed.clear();
  owner = "";
  clearTimeout(retry);
  retry = undefined;
}

/**
 * Resolves every uid not already known or in flight, in one batched call.
 * Never throws: a failure leaves the names unresolved (skeleton) and retries
 * once per retryMs until it lands. A directory switched off (404) does not retry.
 */
export async function ensureNames(uids: Iterable<string>, session: ConnectSession): Promise<void> {
  if (owner !== session.uid) {
    resetNames();
    owner = session.uid;
  }
  const want = [...new Set(uids)].filter(
    (uid) => /^[1-9]\d*$/.test(uid) && !known.has(uid) && !pending.has(uid),
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

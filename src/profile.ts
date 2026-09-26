// The signed-in user's own display name and avatar.
//
// Where the name actually comes from (verified 2026-09-22, T-UX2 PR3):
//
//   agentia-portal  GET /api/auth/me  ->  user.profile.{nickname,displayName,avatar}
//     (agentia-portal/src/model/user.go:235-247, :365-374, :442-448)
//   nucleagent-auth  portalauth/portal.go:148-156  decodes ONLY {id, openId}
//     and drops the rest of the response, including the whole profile object.
//   nucleagent-auth  portalauth/store.go  then invents
//     NickName = fmt.Sprintf("Portal user %d", portalID).
//
// So the portal does publish a real name and avatar, and every consumer —
// this app, the shell, contacts search — reads the local placeholder instead.
// Fixing that is a nucleagent-auth change (decode user.profile in portalUser()
// and persist it to NickName/HeaderImg), not a frontend one.
//
// What this module does is the half that IS im-web's: actually consume the
// profile endpoint that already exists, instead of throwing away everything
// except the access token. Local-password accounts have a real nickName today
// and get it immediately; portal accounts will show their real name the moment
// the auth change above lands, with no further work here.
import { authBase, type ConnectSession } from "./api.ts";

export interface UserProfile {
  displayName: string;
  avatar: string;
}

function storageKey(uid: string): string {
  return `im-web.profile.${uid}`;
}

function store(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Storage blocked by policy; the name simply will not survive a reload.
    return undefined;
  }
}

/**
 * True for a name the auth database invented because the portal profile was
 * discarded. Treated as absent so the identity card shows its own, clearer
 * "Portal user <uid>" fallback rather than presenting a placeholder as if the
 * user had chosen it.
 */
export function isPlaceholderName(name: string): boolean {
  return /^Portal user \d+$/.test(name.trim());
}

/** Per-account, like the contacts cache: the shell can swap users with no sign-out between. */
export function loadCachedProfile(uid: string): UserProfile | undefined {
  try {
    const raw = store()?.getItem(storageKey(uid));
    if (!raw) return undefined;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Partial<UserProfile>;
    if (typeof value.displayName !== "string") return undefined;
    return { displayName: value.displayName, avatar: typeof value.avatar === "string" ? value.avatar : "" };
  } catch {
    // A corrupt cache must never block sign-in; a missing name is the lesser failure.
    return undefined;
  }
}

export function saveCachedProfile(uid: string, profile: UserProfile): void {
  try {
    store()?.setItem(storageKey(uid), JSON.stringify(profile));
  } catch {
    // Private mode or an exhausted quota is not worth failing a sign-in over.
  }
}

export function clearCachedProfile(uid: string): void {
  try {
    store()?.removeItem(storageKey(uid));
  } catch {
    // Nothing actionable — the profile is display-only.
  }
}

/**
 * Reads this account's profile from auth. Returns undefined rather than
 * throwing for every failure: a missing name must never block signing in or
 * sending a message, and the identity card already has a fallback. This is the
 * same endpoint and the same nickName-then-username precedence the shell uses
 * (nucleagent-web/src/addons/shell-session/store/session.ts:106-108).
 */
export async function fetchProfile(session: ConnectSession): Promise<UserProfile | undefined> {
  let response: Response;
  try {
    response = await fetch(`${authBase}/api/v1/addons/auth/user-info`, {
      headers: { Authorization: session.jwt },
    });
  } catch {
    return undefined;
  }
  if (!response.ok) return undefined;

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return undefined;
  }
  const data = (body as { code?: number; data?: Record<string, unknown> } | null)?.data;
  if (!data || (body as { code?: number }).code !== 0) return undefined;

  const nickName = typeof data.nickName === "string" ? data.nickName.trim() : "";
  const username = typeof data.username === "string" ? data.username.trim() : "";
  const avatar = typeof data.headerImg === "string" ? data.headerImg.trim() : "";

  // A portal account's username is a random "portal_<uuid>", which is worse to
  // look at than the UID fallback, so it is only used when it is a real one.
  const name = isPlaceholderName(nickName) ? "" : nickName;
  const fallback = username.startsWith("portal_") ? "" : username;
  const displayName = name || fallback;
  if (!displayName && !avatar) return undefined;
  return { displayName, avatar };
}

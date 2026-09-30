// Conversations hydrate from WuKongIM, which only knows UIDs. names.ts resolves them via
// auth directory/resolve; this per-account cache of names already seen (search, groups)
// lets a reload paint real names before that call returns.
//
// Display names only: no token, no credential, nothing that could resume a session.
import type { Contact, GroupMember } from "./api";

// Keyed per account. A shared key would let one user's cached names render inside another
// user's session on the same browser — the shell can swap accounts by pushing a new token
// straight into adoptShellSession, with no logout in between to clear anything.
const cacheLimit = 200;

function storageKey(uid: string): string {
  return `im-web.contacts.${uid}`;
}

function store(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    // Accessing localStorage throws outright when storage is blocked by policy.
    return undefined;
  }
}

function isContact(value: unknown): value is Contact {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<Contact>;
  return Number.isFinite(Number(candidate.id))
    && (typeof candidate.username === "string" || typeof candidate.displayName === "string");
}

export function loadCachedContacts(uid: string): Contact[] {
  try {
    const raw = store()?.getItem(storageKey(uid));
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isContact) : [];
  } catch {
    // A corrupt cache must never block sign-in; a missing name is the lesser failure.
    return [];
  }
}

export function saveCachedContacts(uid: string, contacts: Contact[]): void {
  try {
    store()?.setItem(storageKey(uid), JSON.stringify(contacts.slice(0, cacheLimit)));
  } catch {
    // Private mode or an exhausted quota is not worth failing a click over.
  }
}

export function clearCachedContacts(uid: string): void {
  try {
    store()?.removeItem(storageKey(uid));
  } catch {
    // Nothing actionable — the cache is display-only.
  }
}

/** Most recently seen first, one entry per uid, newest wins. */
export function mergeContacts(current: Contact[], incoming: Contact[]): Contact[] {
  const merged = new Map<number, Contact>();
  for (const contact of [...incoming, ...current]) {
    if (!merged.has(contact.id)) merged.set(contact.id, contact);
  }
  return [...merged.values()].slice(0, cacheLimit);
}

export function contactsFromMembers(members: GroupMember[]): Contact[] {
  return members.map((member) => ({
    id: member.uid,
    username: member.username,
    displayName: member.displayName,
    accountType: member.accountType,
  }));
}

/**
 * The P1 fallback chain: a name we already know, else undefined so the caller can decide
 * how to render a name still resolving (a skeleton, never the UID). Never returns "".
 */
export function resolveContactName(contacts: Contact[], uid: string): string | undefined {
  const contact = contacts.find((item) => String(item.id) === uid);
  return contact?.displayName || contact?.username || undefined;
}

/** WuKongIM person channels are numeric UIDs; anything else cannot be dialled. */
export function isDialableUid(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

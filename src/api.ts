import { outerAware } from "./outerHost.ts";
export const authBase = trimBase(outerAware(import.meta.env?.VITE_AUTH_BASE || "http://127.0.0.1:26670"));
export const imBase = trimBase(outerAware(import.meta.env?.VITE_IM_BASE || "http://127.0.0.1:26655"));
export const minContactQueryLength = 2;

export interface ConnectSession {
  uid: string;
  token: string;
  wsAddr: string;
  jwt: string;
}

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

export interface LoginData {
  accessToken: string;
}

interface ConnectData {
  uid: string;
  token: string;
  wsAddr: string;
}

export interface Contact {
  id: number;
  username: string;
  displayName: string;
  accountType: "human" | "agent";
}

export interface IMGroup {
  id: number;
  title: string;
  creatorUid: number;
  wukongChannelId: string;
}

export interface GroupMember {
  uid: number;
  username: string;
  displayName: string;
  avatar: string;
  accountType: "human" | "agent";
}

export interface GroupMembers {
  group: IMGroup;
  members: GroupMember[];
}

export interface AgentAllowlist {
  groupId: number;
  agentUid: number;
  ownerUid: number;
  ownerImplicit: boolean;
  memberUids: number[];
}

function trimBase(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned invalid JSON (${response.status})`);
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const body = await readJson(response) as Partial<Envelope<T>> & { detail?: string };
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(body.message || body.detail || `Request failed (${response.status})`);
  }
  return body.data;
}

async function request<T>(
  base: string,
  path: string,
  session: ConnectSession,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Authorization: session.jwt,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  return readEnvelope<T>(response);
}

/**
 * The shell re-pushes a renewed login token every ~10 min. If it is the same user, only the
 * login token changes: no connect-token mint, because im registers every mint with WuKongIM as
 * the master device and WuKongIM kicks the live socket ~10 s later (the 未连接 flash). The
 * claim is read unverified only to choose renew-vs-rebuild; im still verifies every use.
 */
export function renewsSameUser(current: ConnectSession | undefined, accessToken: string): boolean {
  try {
    const payload = accessToken.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    return !!current && String(JSON.parse(atob(payload)).userId) === current.uid;
  } catch {
    return false; // unreadable token: rebuild, the pre-fix behaviour
  }
}

// Local password, portal SSO and refresh all return the same local login envelope, so
// the IM handoff is shared: one connect-token exchange bound to that access token.
export async function imSession(login: LoginData): Promise<ConnectSession> {
  if (!login.accessToken) throw new Error("Auth response did not include accessToken");
  const connectResponse = await fetch(`${imBase}/api/v1/im/connect-token`, {
    method: "POST",
    headers: {
      Authorization: login.accessToken,
    },
  });
  const connect = await readEnvelope<ConnectData>(connectResponse);
  if (!connect.uid || !connect.token || !connect.wsAddr) {
    throw new Error("IM response must include uid, token, and wsAddr");
  }
  return { ...connect, jwt: login.accessToken };
}

export async function createSession(username: string, password: string): Promise<ConnectSession> {
  const loginResponse = await fetch(`${authBase}/api/v1/addons/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Refresh-Cookie-Only": "1",
    },
    body: JSON.stringify({ username, password }),
  });
  return imSession(await readEnvelope<LoginData>(loginResponse));
}

// The SSE stream authenticates with the Auth access token, whose TTL is 15 minutes.
// Rotating it needs the HttpOnly refresh cookie, then a fresh IM connect token so the
// wsAddr/token pair stays consistent with the new JWT.
//
// The server rotates the refresh token on every call and treats a *second* call with a
// different X-Refresh-Request-ID as reuse, which revokes the entire family and signs the
// user out everywhere. Boot restore adds a second caller alongside the stream's expiry
// refresh, so in-flight calls share one promise: concurrent callers get the same rotation
// instead of racing into reuse detection.
let inFlightRefresh: Promise<ConnectSession> | undefined;

export function refreshSession(): Promise<ConnectSession> {
  inFlightRefresh ??= rotateSession().finally(() => {
    inFlightRefresh = undefined;
  });
  return inFlightRefresh;
}

async function rotateSession(): Promise<ConnectSession> {
  const refreshResponse = await fetch(`${authBase}/api/v1/addons/auth/refresh-token`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Refresh-Cookie-Only": "1",
      "X-Refresh-Request-ID": refreshRequestId(),
    },
    body: "{}",
  });
  return imSession(await readEnvelope<LoginData>(refreshResponse));
}

// The server requires a 16-128 character request identifier in cookie-only mode.
function refreshRequestId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function postIM<T>(
  path: string,
  body: Record<string, unknown>,
  session: ConnectSession,
): Promise<T> {
  const response = await fetch(`${imBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: session.jwt,
      "Content-Type": "application/json",
      token: session.token,
    },
    body: JSON.stringify(body),
  });
  const data = await readJson(response) as T | Envelope<T>;
  if (!response.ok) {
    throw new Error((data as Partial<Envelope<T>>).message || `IM request failed (${response.status})`);
  }
  if (typeof data === "object" && data !== null && "code" in data && "data" in data) {
    const envelope = data as Envelope<T>;
    if (envelope.code !== 0) throw new Error(envelope.message || "IM request failed");
    return envelope.data;
  }
  return data as T;
}

export async function searchContacts(
  query: string,
  session: ConnectSession,
  limit = 20,
): Promise<Contact[]> {
  const q = query.trim();
  if (q.length < minContactQueryLength) return [];
  const params = new URLSearchParams({ q, limit: String(limit) });
  return request<Contact[]>(authBase, `/api/v1/addons/auth/contacts/search?${params}`, session);
}

export async function recipientEnabled(uid: string, session: ConnectSession): Promise<boolean> {
  const data = await request<{ enabled: boolean }>(
    imBase, `/api/v1/im/recipients/${encodeURIComponent(uid)}`, session,
    { cache: "no-store", signal: AbortSignal.timeout(5000) },
  );
  if (typeof data.enabled !== "boolean") throw new Error("Invalid recipient status");
  return data.enabled;
}

// A directory entry is either a local account (id = IM uid) or a portal user
// who has never logged in (id 0, provisioned false) — resolve those with
// provisionContact before opening a channel.
export interface DirectoryEntry extends Contact {
  /** UNI-OID: the person's address (Agentia Open ID); null for local-only accounts (D2). Absent on an older auth. */
  openId?: string | null;
  /** Legacy (UNI-OID phase 3 removes it): used only when an entry has no openId. */
  portalUid?: number;
  provisioned: boolean;
  /** B2 (UNI-IMUX4): https avatar, "" when none. Absent on an older auth. */
  avatar?: string;
  /** UNI-PHONESEARCH: masked phone (138****1234); null = none to show. Never the full number. */
  phoneMasked?: string | null;
}

/**
 * The digits of phone-like input (spaces, dashes and a +86 prefix ignored),
 * or "" when the input is not one: anything else in it, or under the 4 digits
 * auth requires. Mirrors auth's phonedisplay.Normalize.
 */
export function phoneDigits(query: string): string {
  const d = query.trim().replace(/[\s-]/g, "").replace(/^\+86/, "");
  return /^\d{4,20}$/.test(d) ? d : "";
}

export interface DirectoryPage {
  items: DirectoryEntry[];
  page: number;
  hasMore: boolean;
  degraded: boolean;
  nextCursor?: string; // browse mode only
}

/** 404 from an auth directory route: the directory is switched off for this env. */
export class NotFound extends Error {}

async function authGet<T>(path: string, session: ConnectSession, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${authBase}${path}`, {
    ...init,
    headers: { Authorization: session.jwt, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  });
  if (response.status === 404) throw new NotFound();
  return readEnvelope<T>(response);
}

/** A number being typed, or text holding a 4+ digit run: never put in a URL. */
const numberLike = (q: string) => /^\+?[\d\s-]+$/.test(q) || /\d{4}/.test(q);

// Directory search (auth userdirectory). When the directory is switched off
// for this env (404), falls back to plain contacts search so the picker keeps
// working with provisioned users only.
// UNI-PHONESEARCH: phone-like input is also sent as `phone`, matched anywhere
// in a portal phone number; a person matching the name or the phone is a hit.
// UNI-PHONESEARCH-2: number-like input travels only in a POST body, so no URL
// (and no access log) ever carries its digits. Names stay on GET.
export async function searchDirectory(
  query: string,
  session: ConnectSession,
  page = 1,
): Promise<DirectoryPage> {
  const q = query.trim();
  if (q.length < minContactQueryLength) return { items: [], page, hasMore: false, degraded: false };
  const path = "/api/v1/addons/auth/directory/search";
  const number = numberLike(q);
  try {
    if (!number) return await authGet<DirectoryPage>(`${path}?${new URLSearchParams({ q, page: String(page) })}`, session);
    const phone = phoneDigits(q);
    return await authGet<DirectoryPage>(path, session, {
      method: "POST",
      body: JSON.stringify(phone ? { q, phone, page } : { q, page }),
    });
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
  }
  // The contacts fallback is GET-only: a number is not sent there.
  const contacts = number ? [] : await searchContacts(q, session);
  return { items: contacts.map((c) => ({ ...c, provisioned: true })), page: 1, hasMore: false, degraded: true };
}

// Browse everyone by name (empty q): keyset-paged, pass nextCursor back for
// the next page. null when the directory is switched off (404) — the picker
// then stays search-only, which is the pre-directory behaviour.
export async function browseDirectory(
  session: ConnectSession,
  cursor = "",
  pageSize = 20,
): Promise<DirectoryPage | null> {
  const params = new URLSearchParams({ pageSize: String(pageSize) });
  if (cursor) params.set("cursor", cursor);
  try {
    return await authGet<DirectoryPage>(`/api/v1/addons/auth/directory/search?${params}`, session);
  } catch (error) {
    if (error instanceof NotFound) return null;
    throw error;
  }
}

export interface ResolvedProfile {
  nickName: string;
  avatar: string;
  accountType: "human" | "agent";
  provisioned: boolean;
  /** UNI-IMUX4: the real login handle; null = none to show (portal_<uuid>). Absent on an older auth. */
  username?: string | null;
  /** UNI-IMUX4: portal-linked (enterprise) account; null = unknown. */
  enterprise?: boolean | null;
  /** UNI-PROFILE1: Agentia Open ID (portal users.open_id); null = none recorded; absent = older auth. */
  openId?: string | null;
  /** UNI-PHONESEARCH: masked phone (138****1234); null = none to show; absent = older auth. */
  phoneMasked?: string | null;
}

export interface ResolvedUser {
  uid: number;
  /** null only when no account has this uid; never an error. */
  profile: ResolvedProfile | null;
}

export interface ResolvePage {
  items: ResolvedUser[];
  degraded: boolean; // portal unreachable: stored names only
}

const resolveBatch = 200; // the server's per-call cap

// Names IM uids for display (auth directory/resolve). Read-only on the server:
// it never provisions anyone. Throws NotFound when the directory is off.
export async function resolveUsers(uids: number[], session: ConnectSession): Promise<ResolvePage> {
  const out: ResolvePage = { items: [], degraded: false };
  for (let i = 0; i < uids.length; i += resolveBatch) {
    const response = await fetch(`${authBase}/api/v1/addons/auth/directory/resolve`, {
      method: "POST",
      headers: { Authorization: session.jwt, "Content-Type": "application/json" },
      body: JSON.stringify({ uids: uids.slice(i, i + resolveBatch) }),
    });
    if (response.status === 404) throw new NotFound();
    const page = await readEnvelope<ResolvePage>(response);
    out.items.push(...page.items);
    out.degraded ||= page.degraded;
  }
  return out;
}

// Maps a portal-only user to their IM uid, creating the local account on first
// contact. Messages sent to that uid wait in WuKongIM until they first log in.
export async function provisionContact(entry: DirectoryEntry, session: ConnectSession): Promise<Contact> {
  if (entry.provisioned && entry.id) return entry;
  const id = await provisionAddress(entry.openId ? { openId: entry.openId } : { portalUid: entry.portalUid }, session);
  return { id, username: entry.username, displayName: entry.displayName, accountType: entry.accountType };
}

/**
 * UNI-OID: an Open ID (or, legacy, a portal id) → this env's IM uid, provisioning
 * on first contact (idempotent: an existing person just returns their uid). The
 * address travels in the POST body only, never in a URL. 404 = no such person.
 */
export async function provisionAddress(address: { openId: string } | { portalUid?: number }, session: ConnectSession): Promise<number> {
  const { id } = await request<{ id: number }>(authBase, "/api/v1/addons/auth/directory/provision", session, {
    method: "POST",
    body: JSON.stringify(address),
  });
  return id;
}

export function listGroups(session: ConnectSession): Promise<IMGroup[]> {
  return request<IMGroup[]>(imBase, "/api/v1/im/groups", session);
}

export function createGroup(
  title: string,
  memberUids: number[],
  session: ConnectSession,
): Promise<IMGroup> {
  return request<IMGroup>(imBase, "/api/v1/im/groups", session, {
    method: "POST",
    body: JSON.stringify({ title, memberUids }),
  });
}

export function getGroupMembers(groupId: number, session: ConnectSession): Promise<GroupMembers> {
  return request<GroupMembers>(imBase, `/api/v1/im/groups/${groupId}/members`, session);
}

export function addGroupMembers(
  groupId: number,
  memberUids: number[],
  session: ConnectSession,
): Promise<GroupMembers> {
  return request<GroupMembers>(imBase, `/api/v1/im/groups/${groupId}/members`, session, {
    method: "POST",
    body: JSON.stringify({ memberUids }),
  });
}

export function removeGroupMember(
  groupId: number,
  uid: number,
  session: ConnectSession,
): Promise<null> {
  return request<null>(imBase, `/api/v1/im/groups/${groupId}/members/${uid}`, session, {
    method: "DELETE",
  });
}

export function deleteGroup(groupId: number, session: ConnectSession): Promise<null> {
  return request<null>(imBase, `/api/v1/im/groups/${groupId}`, session, {
    method: "DELETE",
  });
}

export function getAgentAllowlist(
  groupId: number,
  agentUid: number,
  session: ConnectSession,
): Promise<AgentAllowlist> {
  return request<AgentAllowlist>(
    imBase,
    `/api/v1/im/groups/${groupId}/agents/${agentUid}/allowlist`,
    session,
  );
}

export function replaceAgentAllowlist(
  groupId: number,
  agentUid: number,
  memberUids: number[],
  session: ConnectSession,
): Promise<AgentAllowlist> {
  return request<AgentAllowlist>(
    imBase,
    `/api/v1/im/groups/${groupId}/agents/${agentUid}/allowlist`,
    session,
    {
      method: "PUT",
      body: JSON.stringify({ memberUids }),
    },
  );
}

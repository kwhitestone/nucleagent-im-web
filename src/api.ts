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

// A directory entry is either a local account (id = IM uid) or a portal user
// who has never logged in (id 0, provisioned false) — resolve those with
// provisionContact before opening a channel.
export interface DirectoryEntry extends Contact {
  portalUid?: number;
  provisioned: boolean;
}

export interface DirectoryPage {
  items: DirectoryEntry[];
  page: number;
  hasMore: boolean;
  degraded: boolean;
}

class NotFound extends Error {}

async function authGet<T>(path: string, session: ConnectSession): Promise<T> {
  const response = await fetch(`${authBase}${path}`, { headers: { Authorization: session.jwt } });
  if (response.status === 404) throw new NotFound();
  return readEnvelope<T>(response);
}

// Directory search (auth userdirectory). When the directory is switched off
// for this env (404), falls back to plain contacts search so the picker keeps
// working with provisioned users only.
export async function searchDirectory(
  query: string,
  session: ConnectSession,
  page = 1,
): Promise<DirectoryPage> {
  const q = query.trim();
  if (q.length < minContactQueryLength) return { items: [], page, hasMore: false, degraded: false };
  try {
    return await authGet<DirectoryPage>(
      `/api/v1/addons/auth/directory/search?${new URLSearchParams({ q, page: String(page) })}`, session);
  } catch (error) {
    if (!(error instanceof NotFound)) throw error;
  }
  const contacts = await searchContacts(q, session);
  return { items: contacts.map((c) => ({ ...c, provisioned: true })), page: 1, hasMore: false, degraded: true };
}

// Maps a portal-only user to their IM uid, creating the local account on first
// contact. Messages sent to that uid wait in WuKongIM until they first log in.
export async function provisionContact(entry: DirectoryEntry, session: ConnectSession): Promise<Contact> {
  if (entry.provisioned && entry.id) return entry;
  const { id } = await request<{ id: number }>(authBase, "/api/v1/addons/auth/directory/provision", session, {
    method: "POST",
    body: JSON.stringify({ portalUid: entry.portalUid }),
  });
  return { id, username: entry.username, displayName: entry.displayName, accountType: entry.accountType };
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

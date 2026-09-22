// Portal SSO handoff, per nucleagent-auth/docs/portal-sso.md.
//
// The auth addon requires the browser Origin to equal its configured
// AUTH_PUBLIC_ORIGIN on both POSTs, and it redirects the portal back to
// `${AUTH_PUBLIC_ORIGIN}/auth/portal`. So im-web can only complete this flow
// when auth is configured with im-web's own origin; otherwise start returns 403
// and the button reports that instead of hanging.
import { authBase, imSession, type ConnectSession } from "./api.ts";

export const callbackPath = "/auth/portal";
const portalBase = `${authBase}/api/v1/addons/auth/portal`;

// The addon signs a 32-byte state and renders it as hex.
const stateFormat = /^[0-9a-f]{64}$/;

export interface PortalCallback {
  state: string;
  token: string;
}

// Portal returns to `${callbackPath}?state=...&token=...`. The credential must
// never persist, so read it from the URL and clear it in the same tick, before
// any await. Returning undefined means "this is not a callback load".
export function readCallback(location: Location, history: History): PortalCallback | undefined {
  if (location.pathname !== callbackPath) return undefined;
  // The docs allow the fragment as well as the query.
  const query = new URLSearchParams(location.search);
  const fragment = new URLSearchParams(location.hash.replace(/^#/, ""));
  const state = query.get("state") || fragment.get("state") || "";
  const token = query.get("token") || fragment.get("token") || "";
  history.replaceState(null, "", location.pathname);
  if (!stateFormat.test(state) || !token) return undefined;
  return { state, token };
}

// True when the callback carried neither credential nor error, i.e. the portal
// denied the request or the link was opened directly. Callers distinguish this
// from a normal login load so the user sees a message, never a blank page.
export function isCallbackPath(location: Location): boolean {
  return location.pathname === callbackPath;
}

export async function startPortalLogin(): Promise<string> {
  const response = await fetch(`${portalBase}/start`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await response.json().catch(() => ({})) as {
    code?: number;
    message?: string;
    data?: { loginUrl?: string };
  };
  const loginUrl = body.data?.loginUrl;
  if (!response.ok || body.code !== 0 || !loginUrl) {
    throw new Error(body.message || `Enterprise sign-in is unavailable (${response.status})`);
  }
  return loginUrl;
}

// Exchanges the one-shot portal credential for the same local login envelope the
// password form receives. The flow cookie is HttpOnly, so `credentials: include`
// is what binds this call to the matching start.
export async function completePortalLogin(callback: PortalCallback): Promise<ConnectSession> {
  const response = await fetch(`${portalBase}/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Refresh-Cookie-Only": "1",
    },
    body: JSON.stringify({ state: callback.state, credential: callback.token }),
  });
  const body = await response.json().catch(() => ({})) as {
    code?: number;
    message?: string;
    detail?: string;
    data?: { accessToken?: string };
  };
  const accessToken = body.data?.accessToken;
  if (!response.ok || body.code !== 0 || !accessToken) {
    throw new Error(
      body.message || body.detail || `Enterprise sign-in failed (${response.status})`,
    );
  }
  return imSession({ accessToken });
}

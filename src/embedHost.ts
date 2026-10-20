/**
 * Agentia host ↔ im-web handshake, ported from core-web
 * src/composables/useEmbedHostHandshake.ts (host side: engine-web NucleAgentPane).
 *
 *   host  agentia:embed-init       {conversationId}          → child nucleagent:ready {conversationId}
 *   host  agentia:embed-credential {conversationId, ucToken} → auth /portal/credential → credential-ack
 *   host  agentia:embed-revoke     {conversationId}          → drop session + auth /logout
 *
 * ready is the child's minimal proof of identity: the host must not hand over the
 * credential before it. Only the conversation that shook hands may deliver or
 * revoke. Hosts are exact origins from VITE_EMBED_HOST_ORIGINS; empty = off.
 *
 * This is not the nucleagent-web shell channel (shell.ts, prism-fusion/remote):
 * that shell pushes nucleagent JWTs; this host pushes a portal UC token once and
 * im-web then owns its session (refresh cookie on its own origin, same-site).
 *
 * Credential discipline: the UC token only passes through as a postMessage payload
 * and a function argument — never stored, logged, or echoed in an ack.
 */
import { configValue } from "./runtimeConfig.ts";

const MAX_CONVERSATION_ID = 200;
const CREDENTIAL_PATH = "/api/v1/addons/auth/portal/credential";
const REVOKE_PATH = "/api/v1/addons/auth/logout";
const AUTH_HEADERS = { "Content-Type": "application/json", "X-Refresh-Cookie-Only": "1" };

type HostMessage =
  | { kind: "init"; conversationId: string }
  | { kind: "credential"; conversationId: string; ucToken: string }
  | { kind: "revoke"; conversationId: string };

/** Parses a host message; anything malformed is dropped without a reply. */
export function embedHostMessage(data: unknown): HostMessage | null {
  if (data === null || typeof data !== "object") return null;
  const message = data as { type?: unknown; payload?: { conversationId?: unknown; ucToken?: unknown } };
  const raw = message.payload?.conversationId;
  const id = typeof raw === "string" ? raw.trim() : "";
  if (!id || id.length > MAX_CONVERSATION_ID) return null;
  switch (message.type) {
    case "agentia:embed-init":
      return { kind: "init", conversationId: id };
    case "agentia:embed-credential": {
      const ucToken = message.payload?.ucToken;
      if (typeof ucToken !== "string" || !ucToken || ucToken.length > 8192) return null;
      return { kind: "credential", conversationId: id, ucToken };
    }
    case "agentia:embed-revoke":
      return { kind: "revoke", conversationId: id };
    default:
      return null;
  }
}

/** Exchanges the UC token for a nucleagent JWT; failure details never leave this function. */
async function exchange(credential: string): Promise<string | null> {
  try {
    const response = await fetch(`${configValue("VITE_AUTH_BASE")}${CREDENTIAL_PATH}`, {
      method: "POST",
      credentials: "include",
      headers: AUTH_HEADERS,
      body: JSON.stringify({ credential }),
    });
    if (!response.ok) return null;
    // Flat {accessToken} today; accept the {code,data} envelope too.
    const body = await response.json() as { accessToken?: unknown; data?: { accessToken?: unknown } };
    const token = body?.data?.accessToken ?? body?.accessToken;
    return typeof token === "string" && token ? token : null;
  } catch {
    return null;
  }
}

/** Revokes the refresh family (cookie) and the JWT. Fire-and-forget: local state is already gone. */
export function revokeServerSession(token: string | undefined): void {
  void fetch(`${configValue("VITE_AUTH_BASE")}${REVOKE_PATH}`, {
    method: "POST",
    credentials: "include",
    headers: token ? { ...AUTH_HEADERS, Authorization: token } : AUTH_HEADERS,
    body: "{}",
    keepalive: true,
  }).catch(() => undefined);
}

export interface EmbedHostOptions {
  /** A trusted host shook hands: im-web is now hosted by agentia, not the nucleagent shell. */
  onInit(): void;
  /** The exchanged nucleagent JWT, or null when auth rejected the credential. */
  onCredential(accessToken: string | null): void;
  /** Drop the local session; return its JWT (if any) so the server family is revoked too. */
  onRevoke(): string | undefined;
}

/** Install once before mount (bootstrap.ts replays an early init). No-op standalone or unconfigured. */
export function installEmbedHost(
  options: EmbedHostOptions,
  configured: string = configValue("VITE_EMBED_HOST_ORIGINS"),
): () => void {
  if (typeof window === "undefined" || window.parent === window) return () => undefined;
  const allowed = new Set(configured.split(",").filter(Boolean));
  if (!allowed.size) return () => undefined;

  let embedded: string | null = null;
  // Bumped by every init and revoke: an exchange that resolves after either belongs to
  // a session the host already replaced or ended, so its JWT is revoked, never adopted.
  let epoch = 0;
  const reply = (origin: string, type: string, payload: Record<string, unknown>) =>
    window.parent.postMessage({ type, payload }, origin);

  const onMessage = (event: MessageEvent) => {
    if (event.source !== window.parent || !allowed.has(event.origin)) return;
    const message = embedHostMessage(event.data);
    if (!message) return;
    if (message.kind === "init") {
      epoch += 1;
      embedded = message.conversationId;
      options.onInit();
      reply(event.origin, "nucleagent:ready", { conversationId: embedded });
      return;
    }
    if (message.conversationId !== embedded) return;
    if (message.kind === "credential") {
      const id = message.conversationId;
      const started = epoch;
      void exchange(message.ucToken).then((accessToken) => {
        if (accessToken && started !== epoch) {
          revokeServerSession(accessToken);
          accessToken = null;
        } else {
          options.onCredential(accessToken);
        }
        reply(event.origin, "nucleagent:credential-ack", { conversationId: id, status: accessToken ? "ok" : "rejected" });
      });
      return;
    }
    // Both sides: clearing only the client would leave the JWT and refresh family usable.
    epoch += 1;
    revokeServerSession(options.onRevoke());
  };

  window.addEventListener("message", onMessage);
  return () => window.removeEventListener("message", onMessage);
}

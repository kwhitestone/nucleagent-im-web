// Shell child bridge. im-web runs both standalone and as the `im` remote
// application inside the nucleagent-web shell.
//
// Embedded, the shell owns login: it holds the refresh cookie and pushes the
// access token over the origin-validated `prism-fusion/remote` channel. im-web
// then does only what it always did with a local envelope — exchange the token
// for an IM connect token (`imSession`). It never renders its own login form
// and never completes a portal callback in this mode, because the callback
// belongs to the shell's origin (nucleagent-auth's AUTH_PUBLIC_ORIGIN is a
// single scalar; see nucleagent-nd-docs/docs/sso-shared-callback-host-*.md).
//
// Validation mirrors core-web's applyShellSession: monotonic sessionVersion,
// bounded token, `source === "shell"`. The credential stays in memory.
import { createRemoteChildChannel } from "./vendor/prism-fusion-plugin-runtime/remote-channel.ts";
import { configValue } from "./runtimeConfig.ts";
import { parseConversationTarget, type ConversationTarget } from "./conversationTarget.ts";

const shellOrigin = configValue("VITE_SHELL_URL");

export interface ShellAuthIntent {
  token: string | null;
  sessionVersion: number;
  /**
   * The shell is re-proving a credential another tab stored (cross-tab sync). It
   * carries no token and vouches for no identity; only a transition from exactly
   * the version this child holds is a revalidation, anything else is a sign-out.
   */
  revalidating?: true;
  /** A duplicate delivery of the revalidation already in progress: ignore it. */
  repeat?: true;
}

/**
 * The shell's account page, for standalone runs: sign-out and every account
 * detail live there only (UNI A-12 ext.), coming back to IM afterwards.
 */
export function shellAccountUrl(): string {
  return new URL("/account?redirect=/im", shellOrigin).toString();
}

/** True when im-web is framed by a parent document, i.e. the shell. */
export function isInShell(): boolean {
  return typeof window !== "undefined" && window.parent !== window;
}

/**
 * Accept a shell `auth` intent, or reject it. Pure so the negative paths are
 * testable without a DOM: a forged source, an out-of-order version, or an
 * oversized token must all fail closed.
 */
export function parseShellAuth(
  payload: unknown,
  lastVersion: number,
  revalidatedFrom: number | null = null,
): ShellAuthIntent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as {
    source?: unknown;
    type?: unknown;
    token?: unknown;
    sessionVersion?: unknown;
    permissions?: unknown;
    revalidation?: unknown;
  };
  if (value.source !== "shell" || value.type !== "auth") return null;
  if (!Number.isSafeInteger(value.sessionVersion) || (value.sessionVersion as number) < 0) return null;
  // A token-bearing intent must move the session forward; a logout (null token)
  // for the current version is still honoured, so the child cannot stay signed
  // in after the shell signs out.
  const version = value.sessionVersion as number;
  const token = value.token;
  if (token !== null && token !== undefined) {
    if (typeof token !== "string" || !token.length || token.length > 8192) return null;
    if (version < lastVersion) return null;
  } else if (version < lastVersion) return null;
  if (value.permissions !== undefined && (!Array.isArray(value.permissions) || value.permissions.length > 512)) {
    return null;
  }
  if (typeof token !== "string" && value.revalidation && typeof value.revalidation === "object" &&
    !Array.isArray(value.revalidation)) {
    const previous = (value.revalidation as { previousVersion?: unknown }).previousVersion;
    if (previous === lastVersion && lastVersion > 0 && version > lastVersion) {
      return { token: null, sessionVersion: version, revalidating: true };
    }
    // The shell delivers each intent more than once (observed: every auth message
    // arrives twice, not always adjacent). A copy of the revalidation that moved the
    // session to this very version is that same revalidation, not a sign-out; it
    // cannot extend or change anything.
    if (revalidatedFrom !== null && previous === revalidatedFrom && version === lastVersion) {
      return { token: null, sessionVersion: version, revalidating: true, repeat: true };
    }
  }
  return { token: typeof token === "string" ? token : null, sessionVersion: version };
}

/**
 * The credential an embedded child should retry with after the server rejected
 * `used`. The shell owns refresh: if it has already pushed a newer token, take it;
 * otherwise ask once and wait (bounded) for the push. Never returns `used`.
 */
export async function nextShellCredential(
  read: () => string | undefined,
  used: string,
  ask: () => void,
  { timeoutMs = 10_000, stepMs = 200, sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)) } = {},
): Promise<string> {
  const fresh = () => { const value = read(); return value && value !== used ? value : undefined; };
  let value = fresh();
  if (value) return value;
  ask();
  for (let waited = 0; waited < timeoutMs; waited += stepMs) {
    await sleep(stepMs);
    value = fresh();
    if (value) return value;
    if (!read()) break; // signed out or session changed: nothing to retry with
  }
  throw new Error("Shell did not provide a newer credential");
}

export interface ShellBridge {
  /** Ask the shell to take the user to its /login (the shell owns the login UI). */
  requestLogin(): boolean;
  /** Ask the shell to open its one account page. */
  requestAccount(): boolean;
  /** Ask the shell to sign out everywhere (the AccountPopover's Sign out). */
  requestLogout(): boolean;
  /** Tell the shell the pushed credential was missing or rejected. */
  reportAuthRequired(reason: "missing" | "rejected"): boolean;
  dispose(): void;
}

export interface ShellBridgeOptions {
  /** Called for every accepted intent; a null token means "signed out". */
  onAuth(intent: ShellAuthIntent): void;
  onConversation?(target: ConversationTarget): void;
}

/** No-op outside a shell frame so standalone im-web is untouched. */
export function installShellBridge(options: ShellBridgeOptions): ShellBridge {
  if (!isInShell()) {
    const no = () => false;
    return { requestLogin: no, requestAccount: no, requestLogout: no, reportAuthRequired: no, dispose: () => undefined };
  }

  let lastVersion = 0;
  let authenticated = false;
  // The version a revalidation in progress started from (null when none).
  let revalidatedFrom: number | null = null;
  const channel = createRemoteChildChannel({
    appId: "im",
    hostOrigin: new URL(shellOrigin).origin,
    allowedHostOrigins: configValue("VITE_SHELL_ALLOWED_ORIGINS"),
    parent: window.parent,
    messages: {
      toChild: ["auth", "conversation"],
      fromChild: ["auth-required", "login-request", "account-request", "logout-request"],
    },
    onMessage(type, payload) {
      if (type === "conversation") {
        const value = payload as { source?: unknown; type?: unknown; sessionVersion?: unknown; target?: unknown } | null;
        if (!authenticated || !value || value.source !== "shell" || value.type !== type || value.sessionVersion !== lastVersion) return;
        const target = parseConversationTarget(value.target);
        if (target) options.onConversation?.(target);
        return;
      }
      if (type !== "auth") return;
      const intent = parseShellAuth(payload, lastVersion, revalidatedFrom);
      if (!intent) return;
      if (intent.repeat) return; // duplicate delivery of a revalidation at this version
      // Remember which version a revalidation started from for as long as the session
      // stays at the version it moved to: a duplicate copy of it can arrive before or
      // after the proven token (same version) and must not read as a sign-out. Any
      // version change forgets it, so an old revalidation replayed later still signs out.
      if (intent.revalidating) revalidatedFrom = lastVersion;
      else if (intent.sessionVersion !== lastVersion || intent.token === null) revalidatedFrom = null;
      lastVersion = intent.sessionVersion;
      authenticated = intent.token !== null;
      options.onAuth(intent);
    },
  });

  const onMessage = (event: MessageEvent) => channel.receive(event);
  window.addEventListener("message", onMessage);
  channel.ready();

  return {
    requestLogin: () => channel.send("login-request", { source: "sub", type: "login-request" }),
    requestAccount: () => channel.send("account-request", { source: "sub", type: "account-request" }),
    requestLogout: () => channel.send("logout-request", { source: "sub", type: "logout-request" }),
    reportAuthRequired: (reason) => channel.send("auth-required", {
      source: "sub",
      type: "auth-required",
      reason,
      sessionVersion: lastVersion,
    }),
    dispose() {
      window.removeEventListener("message", onMessage);
      channel.dispose();
    },
  };
}

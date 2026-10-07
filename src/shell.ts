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
import { outerAware } from "./outerHost.ts";
import { parseConversationTarget, type ConversationTarget } from "./conversationTarget.ts";

const shellOrigin = outerAware(import.meta.env?.VITE_SHELL_URL || "http://localhost:26600");

export interface ShellAuthIntent {
  token: string | null;
  sessionVersion: number;
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
export function parseShellAuth(payload: unknown, lastVersion: number): ShellAuthIntent | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as {
    source?: unknown;
    type?: unknown;
    token?: unknown;
    sessionVersion?: unknown;
    permissions?: unknown;
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
  return { token: typeof token === "string" ? token : null, sessionVersion: version };
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
  const channel = createRemoteChildChannel({
    appId: "im",
    hostOrigin: new URL(shellOrigin).origin,
    allowedHostOrigins: import.meta.env?.VITE_SHELL_ALLOWED_ORIGINS,
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
      const intent = parseShellAuth(payload, lastVersion);
      if (!intent) return;
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

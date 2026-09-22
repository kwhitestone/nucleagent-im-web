// Vendored from `@prism-fusion/plugin-runtime` — see VENDORED.md.
//
// Source: kwhitestone/prism-fusion @ 45d6fc57545443e4055cf20b393720a597c1a854,
//         src/web/src/plugin/remote-channel.ts (pkg v2.1.0)
//
// Copied verbatim except for the host half: `createRemoteHostChannel` and
// `RemoteHostChannelOptions` are omitted because they require
// `validateRemoteApplication`, which imports `vue-router` — a dependency
// im-web does not have and must not acquire to be an iframe child. The
// envelope helpers and `createRemoteChildChannel` below are unmodified, so the
// wire protocol is bit-identical to the host's.
import { validateMessageCapabilities } from "./remote-registry.ts";
import type { RemoteMessageCapabilities } from "./remote-registry.ts";

export const REMOTE_PROTOCOL = "prism-fusion/remote";
export const REMOTE_PROTOCOL_VERSION = 1;
export interface RemoteEnvelope {
  protocol: typeof REMOTE_PROTOCOL;
  version: number;
  appId: string;
  instanceId: string;
  type: string;
  payload?: unknown;
}
export interface RemoteMessageTarget { postMessage(message: unknown, targetOrigin: string): void; }
export interface RemoteMessageEvent { source: unknown; origin: string; data: unknown; }
type Receiver = (type: string, payload: unknown) => void;

function envelope(data: unknown): data is RemoteEnvelope {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const message = data as RemoteEnvelope;
  return message.protocol === REMOTE_PROTOCOL && Number.isSafeInteger(message.version) &&
    typeof message.appId === "string" && typeof message.type === "string" &&
    typeof message.instanceId === "string" && /^[a-zA-Z0-9-]{16,128}$/.test(message.instanceId);
}

const message = (appId: string, instanceId: string, type: string, payload?: unknown): RemoteEnvelope => ({
  protocol: REMOTE_PROTOCOL, version: REMOTE_PROTOCOL_VERSION, appId, instanceId, type,
  ...(payload === undefined ? {} : { payload })
});

export interface RemoteChildChannelOptions {
  appId: string;
  hostOrigin: string;
  parent: RemoteMessageTarget;
  messages: RemoteMessageCapabilities;
  onMessage?: Receiver;
  onConnected?: () => void;
}

/** Caller owns the DOM listener and invokes ready only after plugin installation. */
export function createRemoteChildChannel(options: RemoteChildChannelOptions) {
  if (!/^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/.test(options.appId)) throw new Error("Invalid remote child ID");
  if (new URL(options.hostOrigin).origin !== options.hostOrigin || !/^https?:\/\//.test(options.hostOrigin)) throw new Error("Invalid remote host origin");
  validateMessageCapabilities(options.messages);
  const capabilities = structuredClone(options.messages);
  let instanceId: string | undefined;
  let mounted = false;
  let connected = false;
  let disposed = false;
  const acknowledge = () => {
    if (!mounted || !instanceId || disposed) return;
    connected = true;
    options.parent.postMessage(message(options.appId, instanceId, "child:ready"), options.hostOrigin);
    options.onConnected?.();
  };
  return {
    get connected(): boolean { return connected && !disposed; },
    ready(): void { if (disposed) throw new Error("Remote child channel is disposed"); mounted = true; acknowledge(); },
    receive(event: RemoteMessageEvent): boolean {
      if (disposed || event.source !== options.parent || event.origin !== options.hostOrigin || !envelope(event.data)) return false;
      const data = event.data;
      if (data.appId !== options.appId || data.version !== REMOTE_PROTOCOL_VERSION) return false;
      if (data.type === "host:init") {
        connected = false;
        instanceId = data.instanceId;
        acknowledge();
        return true;
      }
      if (!connected || data.instanceId !== instanceId || !capabilities.toChild.includes(data.type)) return false;
      options.onMessage?.(data.type, data.payload);
      return true;
    },
    send(type: string, payload?: unknown): boolean {
      if (!connected || disposed || !instanceId || !capabilities.fromChild.includes(type)) return false;
      options.parent.postMessage(message(options.appId, instanceId, type, payload), options.hostOrigin);
      return true;
    },
    dispose(): void { disposed = true; connected = false; instanceId = undefined; }
  };
}

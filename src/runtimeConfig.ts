// Public browser endpoints, read at startup from /runtime-config.json (written
// by docker-entrypoint.d/40-runtime-config.sh from a fixed env whitelist), so
// one image serves every environment. Same contract as core-web's runtimeConfig.
import { outerAware } from "./outerHost.ts";

export const RUNTIME_CONFIG_KEYS = [
  "VITE_AUTH_BASE",
  "VITE_IM_BASE",
  "VITE_CORE_BASE",
  "VITE_SHELL_URL",
  "VITE_SHELL_ALLOWED_ORIGINS",
  "VITE_ACCOUNT_UI_URL",
] as const;
export type RuntimeConfigKey = (typeof RUNTIME_CONFIG_KEYS)[number];
export type RuntimeConfig = Readonly<Record<RuntimeConfigKey, string>>;

const namespaceOf = (host: string) => host.slice(host.indexOf("."));

function httpsUrl(value: unknown, key: string, allowPath = false): URL {
  // Never echo operator input: a malformed URL may contain a credential.
  const invalid = () => new Error(`runtime-config.json: invalid ${key}`);
  if (typeof value !== "string" || value.trim() !== value) throw invalid();
  let url: URL;
  try { url = new URL(value); } catch { throw invalid(); }
  const exact = allowPath
    ? url.href === value && !url.username && !url.password && !url.search && !url.hash && /^\/[\w./-]*$/.test(url.pathname)
    : url.origin === value;
  if (url.protocol !== "https:" || !exact ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+){2,}$/.test(url.hostname) || /^[\d.]+$/.test(url.hostname)) throw invalid();
  return url;
}

/** Validates every key and maps inner hosts to the page's outer twin (outerHost.ts). */
export function parseRuntimeConfig(body: unknown, pageOrigin: string): RuntimeConfig {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("runtime-config.json: expected an object");
  }
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some(key => !(RUNTIME_CONFIG_KEYS as readonly string[]).includes(key))) {
    throw new Error("runtime-config.json: unexpected keys");
  }
  const page = httpsUrl(pageOrigin, "page");
  const namespace = namespaceOf(page.hostname);
  // Every endpoint must belong to the page's own environment, never a sibling one.
  const endpoint = (value: unknown, key: string, allowPath = false): string => {
    httpsUrl(value, key, allowPath);
    const mapped = outerAware(value as string, page.hostname);
    if (namespaceOf(new URL(mapped).hostname) !== namespace) {
      throw new Error(`runtime-config.json: ${key} crosses the environment namespace`);
    }
    return mapped;
  };
  const out = {} as Record<RuntimeConfigKey, string>;
  for (const key of RUNTIME_CONFIG_KEYS) {
    const value = input[key];
    if (key === "VITE_SHELL_ALLOWED_ORIGINS") {
      // Optional, as before: empty keeps VITE_SHELL_URL as the single trusted shell.
      const list = value === undefined ? "" : value;
      const invalid = () => new Error(`runtime-config.json: invalid ${key}`);
      if (typeof list !== "string") throw invalid();
      out[key] = list === "" ? "" : list.split(",").map(item => {
        let url: URL;
        try { url = new URL(item); } catch { throw invalid(); }
        if (!["http:", "https:"].includes(url.protocol) || url.origin !== item || url.port === "0") throw invalid();
        return outerAware(url.origin, page.hostname);
      }).join(",");
    } else if (key === "VITE_ACCOUNT_UI_URL") {
      // Must be present; explicit empty keeps the degraded avatar+name card.
      if (typeof value !== "string") throw new Error(`runtime-config.json: missing ${key}`);
      out[key] = value === "" ? "" : endpoint(value, key, true);
    } else {
      out[key] = endpoint(value, key);
    }
  }
  return Object.freeze(out);
}

export async function fetchRuntimeConfig(pageOrigin: string, fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  const page = httpsUrl(pageOrigin, "page");
  const response = await fetchImpl(`${page.origin}/runtime-config.json`, {
    headers: { accept: "application/json" }, credentials: "omit",
    cache: "no-store", redirect: "error", signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`runtime-config.json: HTTP ${response.status}`);
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new Error("runtime-config.json: invalid JSON"); }
  return parseRuntimeConfig(body, page.origin);
}

let current: RuntimeConfig | undefined;
let pending: Promise<void> | undefined;
export function loadRuntimeConfig(pageOrigin = location.origin, fetchImpl: typeof fetch = fetch): Promise<void> {
  return pending ??= fetchRuntimeConfig(pageOrigin, fetchImpl).then(config => { current = config; });
}

export function configValue(key: RuntimeConfigKey): string {
  if (!current) throw new Error("runtime-config.json: not initialized");
  return current[key];
}

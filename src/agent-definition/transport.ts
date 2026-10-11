import { DefinitionError, type Transport } from "./api.ts";

export function sessionTransport(
  base: string,
  current: () => { uid: string; jwt: string } | undefined,
  fetcher: typeof fetch = fetch,
): Transport {
  return async (path, init = {}) => {
    const origin = new URL(base);
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password
      || origin.pathname !== "/" || origin.search || origin.hash || !path.startsWith("/api/v1/")) throw new Error("Invalid Core origin");
    const session = current();
    if (!session?.jwt) throw new DefinitionError(401, "unauthenticated");
    const headers = new Headers(init.headers);
    headers.set("Authorization", session.jwt);
    const timeout = AbortSignal.timeout(15000);
    const response = await fetcher(`${origin.origin}${path}`, {
      ...init, headers, credentials: "omit", cache: "no-store",
      signal: init.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
    const body: unknown = await response.json();
    if (current()?.uid !== session.uid || current()?.jwt !== session.jwt) throw new DefinitionError(401, "session_changed");
    return { status: response.status, headers: { etag: response.headers.get("ETag") || "" }, body };
  };
}

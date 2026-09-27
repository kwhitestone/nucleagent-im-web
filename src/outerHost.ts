/**
 * UNI-OUTER: one bundle serves both the inner (*.sdp.ndaeweb.com) and the outer
 * (*.new.ndhy.com) domain of a site — both are bound to the same cluster. When
 * the page itself is on an outer host, every baked inner URL is switched to its
 * outer twin, so an outer page only ever talks to outer frontends and backends
 * (same registrable domain: the HttpOnly refresh cookie stays first-party).
 * Any other host (inner domain, localhost, tests) leaves URLs untouched.
 *
 * Identical copy in each frontend repo (web, core-web, im-web, auth-web,
 * deliverables-web, executor-web); keep them in sync.
 */
const INNER = ".sdp.ndaeweb.com";
const OUTER = ".new.ndhy.com";

function currentHost(): string {
  return (globalThis as { location?: { hostname?: string } }).location?.hostname ?? "";
}

/** Switches an absolute inner URL to its outer twin when the page is on an outer host. */
export function outerAware(url: string, host: string = currentHost()): string {
  if (!url || !host.endsWith(OUTER)) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url; // relative or empty: already same-origin
  }
  if (!parsed.hostname.endsWith(INNER)) return url;
  parsed.hostname = parsed.hostname.slice(0, -INNER.length) + OUTER;
  // new URL() normalises "https://a.b" to "https://a.b/"; keep the caller's shape.
  const out = parsed.toString();
  return url.endsWith("/") ? out : out.replace(/\/$/, "");
}

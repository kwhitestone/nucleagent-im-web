// IM3-D5 (Q3 §5): the search page's data layer. im GET /api/v1/im/search answers messages and
// file names in the caller's own conversations (2–64 characters; one character is refused, an
// ngram token being two); conversations, agents and (one character) people match locally on titles.
import { Channel } from "wukongimjssdk";
import { imBase, type ConnectSession } from "./api.ts";

export type QueryMode = "idle" | "single" | "full" | "tooLong";
export type Range = [number, number];
export interface Segment { text: string; hit: boolean }

export const queryMax = 64; // im searchQueryMax

export function queryMode(raw: string): QueryMode {
  const n = [...raw.trim()].length;
  if (!n) return "idle";
  if (n === 1) return "single";
  return n > queryMax ? "tooLong" : "full";
}

export interface MessageHit {
  id: string;
  seq: number;
  channel: Channel;
  fromUid: string;
  timestamp: number;
  hidden: boolean;
  snippet: string;
  ranges: Range[];
  file: boolean;
}

export interface MessagePage { hits: MessageHit[]; total: number; nextCursor: string }

export async function messageSearch(q: string, type: "message" | "file", session: ConnectSession, cursor = ""): Promise<MessagePage> {
  const params = new URLSearchParams({ q: q.trim(), type });
  if (cursor) params.set("cursor", cursor);
  const response = await fetch(`${imBase}/api/v1/im/search?${params}`, { headers: { Authorization: session.jwt } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.detail || body?.message || `search failed (${response.status})`);
  return {
    total: Number(body.total || 0),
    nextCursor: String(body.next_cursor || ""),
    hits: (body.messages || []).map((m: Record<string, any>) => ({
      id: String(m.message_idstr),
      seq: Number(m.message_seq),
      channel: new Channel(String(m.channel_id), Number(m.channel_type)),
      fromUid: String(m.from_uid),
      timestamp: Number(m.timestamp || 0),
      hidden: !!m.hidden,
      snippet: String(m.snippet || ""),
      ranges: Array.isArray(m.ranges) ? m.ranges : [],
      file: type === "file",
    })),
  };
}

/**
 * Splits text into plain and hit segments by character ranges. The page renders segments as
 * text and hits as <mark> elements, so a message's own markup is never interpreted (the
 * server's snippet_html is not used).
 */
export function markSegments(text: string, ranges: Range[] = []): Segment[] {
  const chars = [...text];
  const valid = ranges.filter(([a, b]) => a >= 0 && b > a && b <= chars.length).sort((x, y) => x[0] - y[0]);
  const out: Segment[] = [];
  let at = 0;
  for (const [a, b] of valid) {
    if (a < at) continue;
    if (a > at) out.push({ text: chars.slice(at, a).join(""), hit: false });
    out.push({ text: chars.slice(a, b).join(""), hit: true });
    at = b;
  }
  if (at < chars.length) out.push({ text: chars.slice(at).join(""), hit: false });
  return out;
}

/** Every case-insensitive occurrence of q in title, in characters; undefined = no match. */
export function titleMatch(title: string, q: string): Range[] | undefined {
  const hay = [...title.toLocaleLowerCase()];
  const needle = [...q.trim().toLocaleLowerCase()];
  if (!needle.length) return undefined;
  const ranges: Range[] = [];
  for (let i = 0; i + needle.length <= hay.length; i++) {
    if (needle.every((c, k) => hay[i + k] === c)) {
      ranges.push([i, i + needle.length]);
      i += needle.length - 1;
    }
  }
  return ranges.length ? ranges : undefined;
}

export function countLabel(n: number): string {
  return n >= 100 ? "99+" : String(n); // im caps total at 100
}

const recentKey = (uid: string) => `nucleagent_im_recent_search:${uid}`;
const recentMax = 10;

export function loadRecentSearches(uid: string): string[] {
  try {
    const list = JSON.parse(localStorage.getItem(recentKey(uid)) || "[]");
    return Array.isArray(list) ? list.filter((q) => typeof q === "string").slice(0, recentMax) : [];
  } catch {
    return [];
  }
}

export function rememberSearch(uid: string, raw: string): void {
  const q = raw.trim();
  if (!q) return;
  const next = [q, ...loadRecentSearches(uid).filter((item) => item !== q)].slice(0, recentMax);
  try { localStorage.setItem(recentKey(uid), JSON.stringify(next)); } catch { /* storage full or off: not worth an error */ }
}

export function clearRecentSearches(uid: string): void {
  try { localStorage.removeItem(recentKey(uid)); } catch { /* ignore */ }
}

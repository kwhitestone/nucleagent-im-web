import type { Message } from "wukongimjssdk";

// UNI-IM-DB W5 (R4): history now carries im's own ids as messageSeq, while live WS messages
// carry WuKong's per-channel seq (which restarts at 1 on a WK reset). The two never compare,
// so messages sort by time and the "load earlier" cursor comes from history rows only.

const persisted = new WeakSet<Message>();

/** Marks messages that came from im's history endpoint (their messageSeq is im's cursor). */
export function markPersisted<T extends Message>(message: T): T {
  persisted.add(message);
  return message;
}

export function messageKey(message: Message): string {
  return message.messageID || message.clientMsgNo || `${message.fromUID}:${message.messageSeq}`;
}

function sameMessage(left: Message, right: Message): boolean {
  if (left.messageID && left.messageID === right.messageID) return true;
  if (left.clientMsgNo && left.clientMsgNo === right.clientMsgNo) return true;
  return messageKey(left) === messageKey(right);
}

/** Incoming replaces its live/persisted twin (same id or client_msg_no); the result is time-ordered. */
export function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const out = [...current];
  for (const message of incoming) {
    const index = out.findIndex((existing) => sameMessage(existing, message));
    if (index >= 0) out[index] = message;
    else out.push(message);
  }
  // Persisted-first on a timestamp tie: within one second only history knows the true order.
  return out.sort((left, right) => left.timestamp - right.timestamp
    || (left.messageSeq && right.messageSeq && persisted.has(left) && persisted.has(right)
      ? left.messageSeq - right.messageSeq : 0));
}

/** Re-marks a copy of a persisted message (the stream path clones before updating). */
export function carryPersisted<T extends Message>(from: Message, to: T): T {
  return persisted.has(from) ? markPersisted(to) : to;
}

/**
 * The start_message_seq for "load earlier": just below the oldest history row. undefined = no
 * history row to page from; 0 = the oldest row is id 1, nothing is older (0 means "latest" to
 * the server, so it is never sent).
 */
export function earlierCursor(messages: Message[]): number | undefined {
  let oldest: number | undefined;
  for (const message of messages) {
    if (persisted.has(message) && message.messageSeq > 0 && (oldest === undefined || message.messageSeq < oldest)) {
      oldest = message.messageSeq;
    }
  }
  return oldest === undefined ? undefined : oldest - 1;
}

/** One connect-token re-mint per failure streak; a Connected in between allows the next one. */
export function remintGuard(): { take(): boolean; reset(): void } {
  let spent = false;
  return {
    take: () => !spent && (spent = true),
    reset: () => { spent = false; },
  };
}

/** A connection lost to auth-fail sooner than this after it connected counts as displaced. */
export const CONFLICT_WINDOW_MS = 30_000;
/** Consecutive quick losses after which this tab stops re-minting by itself. */
export const CONFLICT_LIMIT = 2;
/** Extra quick losses an explicit "use here" absorbs, so the takeover outlasts the other tab. */
export const CONFLICT_TAKEOVER_BONUS = 2;
/** Quick losses further apart than this are unrelated (a displacement loop repeats every ~7 s). */
export const CONFLICT_STREAK_GAP_MS = 120_000;

export interface ConnectionConflict {
  connected(now: number): void;
  /** The socket closed (any reason); a connection's lifetime ends here, not at the later auth-fail. */
  lost(now: number): void;
  /** True when this auth-fail is a displacement conflict: do not re-mint, yield. */
  authFailed(now: number): boolean;
  /** This tab gave the connection up and has not connected since. */
  yielded(): boolean;
  takeOver(): void;
  /** An automatic probe: one more quick loss yields again (no extra allowance). */
  probe(): void;
  /** Yield at once (a probe or takeover lost the race before it connected). */
  yieldNow(): void;
  reset(): void;
}

/**
 * MUYU-161 D11: when both tabs yielded at once (real DEV trace 2026-10-27 11:26Z: the server
 * accepted two concurrent connections, then closed both), nobody reconnected until the user
 * clicked "use here". A yielded tab now probes by itself, with a bounded budget and jittered,
 * growing delays — but never while another tab of the same account (same browser) reports a
 * live connection, so a settled winner is not displaced. Before each probe the tab asks the
 * channel who holds the connection, so a throttled background holder still answers in time.
 * Limits (bounded): tabs in different browsers (or storage partitions) cannot hear each other;
 * there only the jitter and the budget (PROBE_DELAYS_MS.length probes per streak) bound it, and if their probes keep
 * colliding both end yielded with "use here" offered. The network coming back (`online`) or the
 * tab becoming visible again, at most once per conflict window (30 s), pulls the next probe forward
 * to the first (short) delay; a spent budget starts a new bounded round. Each probe still uses one
 * budget slot: never timer-driven endless probing. A long-lived
 * winner in the other browser is then interrupted at most once per probe (about 5 s each, at most
 * PROBE_DELAYS_MS.length per streak) and takes the
 * connection back by its ordinary single re-mint. Channel messages carry no credential;
 * a same-origin page could forge them, which only delays or suppresses the automatic probe.
 */
/** Bounded per streak; the long tail covers a rival in another browser that leaves minutes later. */
export const PROBE_DELAYS_MS = [6_000, 15_000, 40_000, 120_000, 300_000];
/** Extra random share of each probe delay, so two yielded tabs do not probe in step. */
export const PROBE_JITTER = 0.6;
/** A peer tab's "connected" report is trusted this long (it repeats every HEARTBEAT_MS). */
export const PEER_FRESH_MS = 25_000;
export const PEER_HEARTBEAT_MS = 10_000;

/** "query": a yielded tab asks who holds the connection; live holders answer at once (not throttled). */
export interface PeerReport { uid: string; tab: string; state: "connected" | "released" | "query" }
/** How long a probing tab waits for live holders to answer its query. */
export const PEER_QUERY_WAIT_MS = 1_500;

export function isPeerReport(value: unknown): value is PeerReport {
  const v = value as Partial<PeerReport> | null;
  return !!v && typeof v.uid === "string" && typeof v.tab === "string" &&
    (v.state === "connected" || v.state === "released" || v.state === "query");
}

/** Same-browser tabs of the same account that recently reported a live IM connection. */
export function peerLiveness(freshMs = PEER_FRESH_MS): {
  /** Records a report; true when it released a tab that was live (a real hand-over). */
  heard(report: PeerReport, now: number): boolean;
  othersConnected(uid: string, self: string, now: number): boolean;
  clear(): void;
} {
  const live = new Map<string, { uid: string; at: number }>();
  return {
    heard: (report, now) => {
      if (report.state === "connected") { live.set(report.tab, { uid: report.uid, at: now }); return false; }
      if (report.state === "released") return live.delete(report.tab);
      return false;
    },
    othersConnected: (uid, self, now) => [...live].some(([tab, seen]) =>
      tab !== self && seen.uid === uid && now - seen.at < freshMs),
    clear: () => live.clear(),
  };
}

/**
 * MUYU-161 D10: WuKongIM keeps one web connection per account (the IM server registers every
 * minted token at device level 1), so another tab's mint closes this tab's socket and the old
 * token then auth-fails. Re-minting on every such auth-fail made two tabs displace each other
 * forever. An auth-fail after a connection that had lived a while (a WuKong reset) still
 * re-mints exactly as before; only auth-fails that keep ending freshly re-minted connections,
 * in quick succession, are a conflict, and from CONFLICT_LIMIT of them on this tab yields.
 * Times are monotonic milliseconds (performance.now()).
 * Known limits (bounded, reviewed): a takeover's allowance only resets on a long-lived loss, so
 * at worst two extra re-mints; performance.now() may not advance during system sleep, so two
 * quick losses around a sleep could make a single tab yield — "use here" recovers it.
 */
export function connectionConflict(
  windowMs = CONFLICT_WINDOW_MS, limit = CONFLICT_LIMIT, takeoverBonus = CONFLICT_TAKEOVER_BONUS,
  streakGapMs = CONFLICT_STREAK_GAP_MS,
): ConnectionConflict {
  let connectedAt: number | undefined;
  let lostAt: number | undefined;
  let lastQuickAt: number | undefined;
  let quickLosses = 0;
  let gaveUp = false;
  const clear = () => { connectedAt = undefined; lostAt = undefined; };
  return {
    connected: (now) => { connectedAt = now; lostAt = undefined; gaveUp = false; },
    lost: (now) => { if (connectedAt !== undefined && lostAt === undefined) lostAt = now; },
    authFailed: (now) => {
      // Only an auth-fail that ends a connection is counted; another one before any success
      // is the re-mint guard's business and changes nothing here.
      if (connectedAt !== undefined) {
        const quick = (lostAt ?? now) - connectedAt < windowMs;
        const stale = lastQuickAt !== undefined && now - lastQuickAt > streakGapMs;
        if (!quick || (stale && quickLosses > 0)) quickLosses = 0;
        if (quick) { quickLosses += 1; lastQuickAt = now; }
        clear();
      }
      if (quickLosses >= limit) gaveUp = true;
      return gaveUp;
    },
    yielded: () => gaveUp,
    takeOver: () => { quickLosses = -takeoverBonus; lastQuickAt = undefined; gaveUp = false; clear(); },
    probe: () => { quickLosses = limit - 1; lastQuickAt = undefined; gaveUp = false; clear(); },
    yieldNow: () => { gaveUp = true; clear(); },
    reset: () => { quickLosses = 0; lastQuickAt = undefined; gaveUp = false; clear(); },
  };
}

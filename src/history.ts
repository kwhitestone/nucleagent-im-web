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

/**
 * MUYU-161 D10: WuKongIM keeps one web connection per account (the IM server registers every
 * minted token at device level 1), so another tab's mint closes this tab's socket and the old
 * token then auth-fails. Re-minting on every such auth-fail made two tabs displace each other
 * forever. An auth-fail that ends a connection which had lived a while (a WuKong reset) still
 * re-mints exactly as before; only auth-fails that keep ending freshly re-minted connections
 * are a conflict, and from CONFLICT_LIMIT of them on this tab yields instead of re-minting.
 */
export function connectionConflict(
  windowMs = CONFLICT_WINDOW_MS, limit = CONFLICT_LIMIT, takeoverBonus = CONFLICT_TAKEOVER_BONUS,
): { connected(now: number): void; authFailed(now: number): boolean; takeOver(): void; reset(): void } {
  let connectedAt: number | undefined;
  let quickLosses = 0;
  return {
    connected: (now) => { connectedAt = now; },
    /** True when this auth-fail is a displacement conflict: do not re-mint, yield. */
    authFailed: (now) => {
      // Only an auth-fail that ends a connection is counted; another one before any success
      // is the re-mint guard's business and changes nothing here.
      if (connectedAt !== undefined) {
        quickLosses = now - connectedAt < windowMs ? quickLosses + 1 : 0;
        connectedAt = undefined;
      }
      return quickLosses >= limit;
    },
    takeOver: () => { quickLosses = -takeoverBonus; connectedAt = undefined; },
    reset: () => { quickLosses = 0; connectedAt = undefined; },
  };
}

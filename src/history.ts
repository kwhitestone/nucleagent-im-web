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

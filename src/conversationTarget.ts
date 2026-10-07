export interface ConversationTarget {
  channelId: string;
  channelType: 1 | 2;
  agentUid: string;
}

const uid = (value: unknown): value is string =>
  typeof value === "string" && /^[1-9]\d{0,19}$/.test(value) && BigInt(value) <= 18446744073709551615n;

export function parseConversationTarget(value: unknown): ConversationTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as ConversationTarget;
  if (typeof target.channelId !== "string" || !/^[!-~]{1,191}$/.test(target.channelId) ||
      (target.channelType !== 1 && target.channelType !== 2) || !uid(target.agentUid)) return null;
  if (target.channelType === 1) {
    const parts = target.channelId.split("@");
    if (parts.length !== 2 || !parts.every(uid) || BigInt(parts[0]) >= BigInt(parts[1]) ||
        !parts.includes(target.agentUid)) return null;
  }
  return { channelId: target.channelId, channelType: target.channelType, agentUid: target.agentUid };
}

/** WuKong stores a canonical DM pair, but its client opens the viewer's peer. */
export function resolveConversationTarget(target: ConversationTarget, viewerUid: string) {
  if (!parseConversationTarget(target) || !uid(viewerUid)) return null;
  if (target.channelType === 2) return { channelID: target.channelId, channelType: 2 };
  const parts = target.channelId.split("@");
  if (!parts.includes(viewerUid)) return null;
  return { channelID: parts.find((id) => id !== viewerUid)!, channelType: 1 };
}

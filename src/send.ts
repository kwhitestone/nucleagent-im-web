import { recipientEnabled, type ConnectSession } from "./api.ts";

/** Composer hint for a refused DM: stopping or deleting a definition both disable its agent account. */
export function recipientDisabledKey(isAgent: boolean): string {
  return isAgent ? "composer.agentDisabled" : "composer.recipientDisabled";
}

/** The fixed notice nucleagent-im posts for a stopped/deleted agent (AGENT-REPLY-1). */
export function isAgentUnavailableNotice(content: unknown): boolean {
  const payload = (content as { contentObj?: Record<string, unknown> } | undefined)?.contentObj;
  return payload?.systemNotice === "agent_unavailable";
}

/** The durable notice nucleagent-im posts when an agent run fails (IM-AGENT-FAILURE-NOTICE). */
export function isExecutionFailedNotice(content: unknown): boolean {
  const payload = (content as { contentObj?: Record<string, unknown> } | undefined)?.contentObj;
  return payload?.systemNotice === "execution_failed";
}

// This protects our client, not arbitrary SDK clients. A transport-wide veto
// would require a verified WuKong pre-send hook, not msg.notify.
export async function sendToEnabledRecipient(
  channel: { channelID: string; channelType: number },
  session: ConnectSession,
  current: () => boolean,
  send: () => Promise<void>,
  mentionUids: string[] = [],
): Promise<"sent" | "disabled" | "unavailable" | "cancelled"> {
  // A DM checks its peer; a group message checks the agents it @-mentions
  // (AG1-B2: a deleted agent is a disabled account and would never answer).
  const recipients = channel.channelType === 1 ? [channel.channelID] : mentionUids;
  for (const uid of recipients) {
    let enabled: boolean | undefined;
    // Bounded, on-demand recovery only. Never clear the draft or fail open.
    for (let attempt = 0; attempt < 2 && current(); attempt++) {
      try {
        enabled = await recipientEnabled(uid, session);
        break;
      } catch {
        // The next send attempt can recover after this bounded retry.
      }
    }
    if (!current()) return "cancelled";
    if (enabled === undefined) return "unavailable";
    if (!enabled) return "disabled";
  }
  if (!current()) return "cancelled";
  await send();
  return "sent";
}

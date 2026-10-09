import { recipientEnabled, type ConnectSession } from "./api.ts";

/** Composer hint for a refused DM: an agent account is disabled only when its definition is deleted. */
export function recipientDisabledKey(isAgent: boolean): string {
  return isAgent ? "composer.agentDeleted" : "composer.recipientDisabled";
}

// This protects our client, not arbitrary SDK clients. A transport-wide veto
// would require a verified WuKong pre-send hook, not msg.notify.
export async function sendToEnabledRecipient(
  channel: { channelID: string; channelType: number },
  session: ConnectSession,
  current: () => boolean,
  send: () => Promise<void>,
): Promise<"sent" | "disabled" | "unavailable" | "cancelled"> {
  if (channel.channelType === 1) {
    let enabled: boolean | undefined;
    // Bounded, on-demand recovery only. Never clear the draft or fail open.
    for (let attempt = 0; attempt < 2 && current(); attempt++) {
      try {
        enabled = await recipientEnabled(channel.channelID, session);
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

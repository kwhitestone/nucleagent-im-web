import { ChannelTypeGroup } from "wukongimjssdk";

/** A group channel the loaded group list does not know yet (e.g. the viewer was just added). */
export function unknownGroup(
  channel: { channelID: string; channelType: number },
  groups: { wukongChannelId: string }[],
): boolean {
  return channel.channelType === ChannelTypeGroup && !groups.some((group) => group.wukongChannelId === channel.channelID);
}

/** Per key: concurrent calls share the pending run; a settled run is not repeated within `ms`. */
export function throttle(ms: number, now: () => number = Date.now) {
  const pending = new Map<string, Promise<void>>();
  const settled = new Map<string, number>();
  return (key: string, run: () => Promise<void>): Promise<void> => {
    const inFlight = pending.get(key);
    if (inFlight) return inFlight;
    if (now() - (settled.get(key) ?? -Infinity) < ms) return Promise.resolve();
    const promise = run().finally(() => { pending.delete(key); settled.set(key, now()); });
    pending.set(key, promise);
    return promise;
  };
}

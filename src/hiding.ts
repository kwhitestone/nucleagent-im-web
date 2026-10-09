// IM3-D4 (Q3 §2): hide / unhide / mark read on one or many conversations.
// The server holds the state per viewer (im_conversations.hidden_at), so this is
// only the client's view of it: the batch call, the hidden list, the selection
// (by channelKey, so it survives paging) and the 5 s undo toast.
import { ref, type Ref, type ShallowRef } from "vue";
import { Channel, type Conversation } from "wukongimjssdk";
import { postIM, type ConnectSession } from "./api.ts";
import { loadConversationPage } from "./im.ts";

export type BatchAction = "hide" | "unhide" | "read";
export const batchLimit = 100; // im rejects >100 channels per call (reads.go batchMax)
export const undoMs = 5000;

export function channelKey(channel: Channel): string {
  return `${channel.channelType}:${channel.channelID}`;
}

export function channelOfKey(key: string): Channel {
  const at = key.indexOf(":");
  return new Channel(key.slice(at + 1), Number(key.slice(0, at)));
}

export interface BatchOutcome { ok: string[]; failed: string[] }

/**
 * One action on any number of channels: chunks of ≤100, results merged. A chunk
 * that fails as a whole (network, 5xx, an im without the endpoint) fails only its
 * own keys. not_found (no row of the caller's: another user's channel) is a failure.
 */
export async function batchConversations(action: BatchAction, keys: string[], session: ConnectSession): Promise<BatchOutcome> {
  const unique = [...new Set(keys)];
  const out: BatchOutcome = { ok: [], failed: [] };
  for (let i = 0; i < unique.length; i += batchLimit) {
    const chunk = unique.slice(i, i + batchLimit);
    try {
      const body = await postIM<{ results?: Array<{ channel_id: string; channel_type: number; ok: boolean }> }>(
        "/api/v1/im/conversation/batch",
        { action, channels: chunk.map((key) => { const c = channelOfKey(key); return { channel_id: c.channelID, channel_type: c.channelType }; }) },
        session,
      );
      const ok = new Set((body?.results || []).filter((r) => r.ok).map((r) => `${r.channel_type}:${r.channel_id}`));
      for (const key of chunk) (ok.has(key) ? out.ok : out.failed).push(key);
    } catch {
      out.failed.push(...chunk);
    }
  }
  return out;
}

/** Every hidden conversation of the caller ({hidden:true} pages until done). */
export async function loadHiddenConversations(session: ConnectSession): Promise<Conversation[]> {
  const all: Conversation[] = [];
  let cursor = "";
  // ponytail: at most 20 pages (1000 rows) of hidden chats; page the view if anyone gets near that.
  for (let page = 0; page < 20; page++) {
    const next = await loadConversationPage(session, cursor, true);
    all.push(...next.conversations);
    cursor = next.nextCursor;
    if (!cursor) break;
  }
  return all;
}

export interface Notice { text: string; undo?: () => Promise<void> }

export function useConversationBatch(options: {
  session: () => ConnectSession | undefined;
  conversations: ShallowRef<Conversation[]>;
  t: (key: string, params?: Record<string, unknown>) => string;
  /** Rows just hidden: the app drops them from the SDK's own cache too. */
  onHidden?: (keys: string[]) => void;
}) {
  const hidden = ref<Conversation[]>([]) as Ref<Conversation[]>;
  const hiddenKeys = ref(new Set<string>());
  const selecting = ref(false);
  const selected = ref(new Set<string>());
  const busy = ref(false);
  const notice = ref<Notice>();
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  const setHidden = (list: Conversation[]) => {
    hidden.value = list;
    hiddenKeys.value = new Set(list.map((c) => channelKey(c.channel)));
  };

  function show(next?: Notice): void {
    clearTimeout(noticeTimer);
    notice.value = next;
    if (next?.undo) noticeTimer = setTimeout(() => { notice.value = undefined; }, undoMs);
  }

  /** Applies a successful action locally, the same way the server just did. */
  function apply(action: BatchAction, keys: string[]): void {
    const done = new Set(keys);
    if (action === "hide") {
      const moving = options.conversations.value.filter((c) => done.has(channelKey(c.channel)));
      for (const c of moving) c.unread = 0;
      options.conversations.value = options.conversations.value.filter((c) => !done.has(channelKey(c.channel)));
      setHidden([...moving, ...hidden.value.filter((c) => !done.has(channelKey(c.channel)))]);
      options.onHidden?.(keys);
    } else if (action === "unhide") {
      const back = hidden.value.filter((c) => done.has(channelKey(c.channel)));
      const shown = new Set(options.conversations.value.map((c) => channelKey(c.channel)));
      options.conversations.value = [...options.conversations.value, ...back.filter((c) => !shown.has(channelKey(c.channel)))];
      setHidden(hidden.value.filter((c) => !done.has(channelKey(c.channel))));
    } else {
      for (const c of options.conversations.value) if (done.has(channelKey(c.channel))) c.unread = 0;
      options.conversations.value = [...options.conversations.value];
    }
  }

  async function run(action: BatchAction, keys: string[]): Promise<BatchOutcome> {
    const session = options.session();
    if (!session || !keys.length) return { ok: [], failed: [] };
    const mine = generation;
    busy.value = true;
    try {
      const outcome = await batchConversations(action, keys, session);
      if (mine !== generation) return outcome;
      apply(action, outcome.ok);
      const undo = action === "hide" && outcome.ok.length ? () => undoHide(outcome.ok) : undefined;
      const text = outcome.failed.length
        ? options.t("hide.partial", { ok: outcome.ok.length, failed: outcome.failed.length })
        : options.t(`hide.done${action[0].toUpperCase()}${action.slice(1)}`, { count: outcome.ok.length });
      show({ text, undo });
      return outcome;
    } finally {
      if (mine === generation) busy.value = false;
    }
  }

  async function undoHide(keys: string[]): Promise<void> {
    show();
    await run("unhide", keys);
  }

  async function undo(): Promise<void> {
    const action = notice.value?.undo;
    if (action) await action();
  }

  /** Selected rows; the failures stay selected (and select mode stays on) to retry. */
  async function runSelected(action: BatchAction): Promise<void> {
    if (busy.value || !selected.value.size) return;
    const outcome = await run(action, [...selected.value]);
    selected.value = new Set(outcome.failed);
    if (!outcome.failed.length) selecting.value = false;
  }

  function startSelecting(first?: string): void {
    selecting.value = true;
    selected.value = new Set(first ? [first] : []);
  }

  function stopSelecting(): void {
    selecting.value = false;
    selected.value = new Set();
  }

  function toggle(key: string): void {
    const next = new Set(selected.value);
    if (!next.delete(key)) next.add(key);
    selected.value = next;
  }

  /** "Select all (loaded)": every row on screen; rows not loaded yet are not guessed at. */
  function selectAll(keys: string[]): void {
    selected.value = new Set([...selected.value, ...keys]);
  }

  /**
   * A pushed/updated conversation. A message from someone else un-hides it on the
   * server (messages.go), so it leaves the hidden list and is shown (true); the
   * viewer's own message from another device keeps it hidden (false: do not show).
   */
  function receive(conversation: Conversation, selfUid: string): boolean {
    const key = channelKey(conversation.channel);
    if (!hiddenKeys.value.has(key)) return true;
    const from = conversation.lastMessage?.fromUID;
    if (!from || from === selfUid) return false;
    setHidden(hidden.value.filter((c) => channelKey(c.channel) !== key));
    return true;
  }

  /** Re-reads the hidden list (reconnect, tab back in front). An older im without it: empty. */
  async function refreshHidden(): Promise<void> {
    const session = options.session();
    if (!session) return;
    const mine = generation;
    try {
      const list = await loadHiddenConversations(session);
      if (mine === generation) setHidden(list);
    } catch {
      if (mine === generation) setHidden([]);
    }
  }

  function reset(): void {
    generation += 1;
    clearTimeout(noticeTimer);
    setHidden([]);
    stopSelecting();
    notice.value = undefined;
    busy.value = false;
  }

  return { hidden, hiddenKeys, selecting, selected, busy, notice, run, runSelected, undo, startSelecting, stopSelecting, toggle, selectAll, receive, refreshHidden, reset, dismiss: () => show() };
}

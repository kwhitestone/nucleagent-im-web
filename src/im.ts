import {
  Channel,
  ChannelInfo,
  Conversation,
  Message,
  MessageStatus,
  Setting,
  WKSDK,
  type MessageContent,
  type SendackPacket,
  type SyncOptions,
} from "wukongimjssdk";
import { postIM, type ConnectSession } from "./api.ts";
import { markPersisted } from "./history.ts";

type Row = Record<string, any>;

function decodeBase64(value: string): string {
  const bytes = Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function contentFromRow(row: Row) {
  const raw = row.payload;
  const json = typeof raw === "string"
    ? (raw.trim().startsWith("{") ? raw : decodeBase64(raw))
    : JSON.stringify(raw || { type: 0 });
  const bytes = new TextEncoder().encode(json);
  const parsed = JSON.parse(json);
  const content = WKSDK.shared().getMessageContent(Number(parsed.type || 0));
  content.decode(bytes);
  return content;
}

function timestampOf(row: Row): number {
  const value = Number(row.timestamp || row.server_timestamp || row.server_timestamp_ms || Date.now());
  if (value > 10_000_000_000_000) return Math.floor(value / 1_000_000_000);
  if (value > 10_000_000_000) return Math.floor(value / 1_000);
  return value;
}

export function messageFromRow(row: Row, fallbackChannel?: Channel): Message {
  const message = new Message();
  // message_idstr: the snowflake exceeds 2^53, so the numeric message_id is not exact in JS.
  message.messageID = String(row.message_idstr || row.message_id_str || row.message_id || "");
  message.messageSeq = Number(row.message_seq || 0);
  message.clientMsgNo = String(row.client_msg_no || message.messageID || crypto.randomUUID());
  message.clientSeq = Number(row.client_seq || 0);
  message.fromUID = String(row.from_uid || "");
  message.channel = new Channel(
    String(row.channel_id || fallbackChannel?.channelID || ""),
    Number(row.channel_type || fallbackChannel?.channelType || 0),
  );
  message.timestamp = timestampOf(row);
  message.status = MessageStatus.Normal;
  message.setting = Setting.fromUint8(Number(row.setting || 0));
  message.content = contentFromRow(row);
  if (typeof row.stream_data === "string") message.streamText = decodeBase64(row.stream_data);
  return message;
}

export function conversationFromRow(row: Row): Conversation {
  const conversation = new Conversation();
  conversation.channel = new Channel(String(row.channel_id), Number(row.channel_type));
  conversation.unread = Number(row.unread || 0);
  conversation.timestamp = timestampOf({ timestamp: row.active_at || 0 });
  conversation.extra = {};
  if (row.last_message) {
    conversation.lastMessage = messageFromRow(row.last_message, conversation.channel);
    conversation.timestamp = conversation.lastMessage.timestamp;
  }
  return conversation;
}

function rows(value: unknown, key: string): Row[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object" && Array.isArray((value as Row)[key])) {
    return (value as Row)[key];
  }
  return [];
}

export function configureSDK(session: ConnectSession): WKSDK {
  const sdk = WKSDK.shared();
  const config = sdk.config;
  config.uid = session.uid;
  config.token = session.token;
  config.addr = session.wsAddr;
  // The platform's Kong edge closes a WebSocket after 60 s with no frame; the SDK's default
  // 60 s heartbeat races that cut and loses (the 未连接 flash). 25 s keeps the socket warm.
  config.heartbeatInterval = 25000;
  config.deviceFlag = 1;
  config.debug = false;

  config.provider.channelInfoCallback = async (channel) => {
    const info = new ChannelInfo();
    info.channel = channel;
    info.title = channel.channelID;
    info.logo = "";
    info.mute = false;
    info.top = false;
    info.orgData = {};
    return info;
  };
  config.provider.syncMessagesCallback = async (channel: Channel, options: SyncOptions) => {
    const result = await postIM<unknown>("/api/v1/im/channel/messagesync", {
      channel_id: channel.channelID,
      channel_type: channel.channelType,
      start_message_seq: options.startMessageSeq,
      end_message_seq: options.endMessageSeq,
      pull_mode: options.pullMode,
      limit: options.limit,
      stream_v2: 1,
    }, session);
    return rows(result, "messages").map((row) => markPersisted(messageFromRow(row, channel)));
  };
  // The SDK's sync() loads the first page; later pages come from loadConversationPage.
  // IM-FIX1: connect, reconnect and "tab back in front" all call sync() and each used to
  // replace the list with page 1 and reset the cursor, so the rows of pages 2+ vanished
  // and scrolling re-requested them. One pull at a time, and as many pages as were loaded.
  if (syncedUid !== session.uid) {
    syncedUid = session.uid;
    loadedPages = 1;
    conversationCursor = "";
    listedChannels = new Set();
    reconciling = new Map();
  }
  config.provider.syncConversationsCallback = () => {
    syncing ??= (async () => {
      const all: Conversation[] = [];
      let cursor = "";
      let pages = 0;
      do {
        const page = await loadConversationPage(session, cursor);
        all.push(...page.conversations);
        cursor = page.nextCursor;
        pages++;
      } while (cursor && pages < loadedPages);
      loadedPages = pages;
      conversationCursor = cursor;
      return all;
    })().finally(() => { syncing = undefined; });
    return syncing;
  };
  sdk.config = config;
  return sdk;
}

let syncedUid = "";
let loadedPages = 1;
let syncing: Promise<Conversation[]> | undefined;
let listedChannels = new Set<string>();
let reconciling = new Map<string, Promise<Conversation | undefined>>();
const conversationKey = (channel: Channel) => `${channel.channelType}:${channel.channelID}`;

/** The cursor for the next conversation page; "" once the list is exhausted. */
export let conversationCursor = "";

export interface ConversationPage {
  conversations: Conversation[];
  nextCursor: string;
}

/**
 * One page of the cursor-paged conversation list (UNI-IM-DB W4: default 50, newest first).
 * hidden: the caller's hidden conversations instead (IM3-D4, Q3 §2).
 */
export async function loadConversationPage(session: ConnectSession, cursor = "", hidden = false, signal?: AbortSignal): Promise<ConversationPage> {
  const listed = listedChannels;
  const body: Row = hidden ? { hidden: true } : {};
  if (cursor) body.cursor = cursor;
  const result = await postIM<Row>("/api/v1/im/conversation/list", body, session, signal);
  const conversations = rows(result, "conversations").map(conversationFromRow);
  if (!hidden && session.uid === syncedUid && listed === listedChannels) {
    for (const conversation of conversations) listed.add(conversationKey(conversation.channel));
  }
  return {
    conversations,
    nextCursor: result && !result.done ? String(result.next_cursor || "") : "",
  };
}

/** The next page after the SDK's first one; [] when there is none. */
export async function loadMoreConversations(session: ConnectSession): Promise<Conversation[]> {
  if (syncing) await syncing.catch(() => undefined); // its cursor, not a stale one
  if (!conversationCursor) return [];
  const page = await loadConversationPage(session, conversationCursor);
  conversationCursor = page.nextCursor;
  loadedPages++;
  return page.conversations;
}

/**
 * SENDACK precedes the list projection. Only new/unconfirmed rows need this bounded read;
 * the SDK's optimistic conversation is not proof that a fresh tab can list it.
 */
export function reconcileAckedConversation(channel: Channel, session: ConnectSession): Promise<Conversation | undefined> {
  const key = conversationKey(channel);
  const listed = listedChannels;
  if (session.uid !== syncedUid || listed.has(key)) return Promise.resolve(undefined);
  const pending = reconciling;
  const existing = pending.get(key);
  if (existing) return existing;
  const current = () => listed === listedChannels && session.uid === syncedUid;
  const work = (async () => {
    for (const wait of [0, 500, 1500]) {
      if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
      if (!current() || listed.has(key)) return;
      try {
        // A head-page probe must not reset the loaded-page cursor or replace the list.
        const page = await loadConversationPage(session, "", false, AbortSignal.timeout(1500));
        if (!current()) return;
        const found = page.conversations.find((item) => item.channel.isEqual(channel));
        if (found) return found;
      } catch {
        console.warn("im_ack_list_read_failed");
      }
    }
    console.warn("im_ack_list_not_visible");
  })().finally(() => { pending.delete(key); });
  pending.set(key, work);
  return work;
}

/**
 * chatManager.send() resolves once the packet is queued; the SDK writes it to the socket on
 * its next 100 ms tick. Closing or reloading the page in between silently lost the message
 * (IM-FIX1: the last group created per tab never got a conversation row). This resolves on
 * WuKongIM's sendack for the packet, and rejects after ackMs so the caller keeps the draft.
 */
export function sendAcked(content: MessageContent, channel: Channel, ackMs = 10000): Promise<Message> {
  const chat = WKSDK.shared().chatManager;
  return new Promise((resolve, reject) => {
    let sent: Message | undefined;
    const early = new Set<number>(); // acks seen before send() returned
    const done = (error?: Error) => {
      clearTimeout(timer);
      chat.removeMessageStatusListener(listener);
      if (error) reject(error);
      else resolve(sent!);
    };
    const listener = (ack: SendackPacket) => {
      if (!sent) early.add(ack.clientSeq);
      else if (ack.clientSeq === sent.clientSeq) done();
    };
    const timer = setTimeout(() => done(new Error("message not acknowledged")), ackMs);
    chat.addMessageStatusListener(listener);
    chat.send(content, channel).then((message) => {
      sent = message;
      if (early.has(message.clientSeq)) done();
    }, (error) => done(error instanceof Error ? error : new Error(String(error))));
  });
}

/** Clears the caller's unread count on a channel (UNI-IM-DB W4 /conversation/read). */
export function markRead(channel: Channel, session: ConnectSession): Promise<unknown> {
  return postIM("/api/v1/im/conversation/read", {
    channel_id: channel.channelID,
    channel_type: channel.channelType,
  }, session);
}

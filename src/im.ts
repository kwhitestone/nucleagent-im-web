import {
  Channel,
  ChannelInfo,
  Conversation,
  Message,
  MessageStatus,
  Setting,
  WKSDK,
  type SyncOptions,
} from "wukongimjssdk";
import { postIM, type ConnectSession } from "./api";

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
  message.messageID = String(row.message_id_str || row.message_id || "");
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

function conversationFromRow(row: Row): Conversation {
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
    const result = await postIM<unknown>("/channel/messagesync", {
      channel_id: channel.channelID,
      channel_type: channel.channelType,
      start_message_seq: options.startMessageSeq,
      end_message_seq: options.endMessageSeq,
      pull_mode: options.pullMode,
      limit: options.limit,
      stream_v2: 1,
    }, session);
    return rows(result, "messages").map((row) => messageFromRow(row, channel));
  };
  config.provider.syncConversationsCallback = async () => {
    const result = await postIM<unknown>("/conversation/list", { limit: 200 }, session);
    return rows(result, "conversations").map(conversationFromRow);
  };
  sdk.config = config;
  return sdk;
}

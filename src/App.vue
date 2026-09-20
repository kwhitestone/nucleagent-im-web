<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from "vue";
import {
  Channel,
  ChannelTypeGroup,
  ChannelTypePerson,
  ConnectStatus,
  Conversation,
  ConversationAction,
  Message,
  MessageText,
  PullMode,
  WKEvent,
  type ConnectStatusListener,
  type ConversationListener,
  type MessageListener,
  type WKEventListener,
  WKSDK,
} from "wukongimjssdk";
import { createSession, type ConnectSession } from "./api";
import { configureSDK } from "./im";
import { parseStreamEvent } from "./stream";

const username = ref("");
const password = ref("");
const loginError = ref("");
const loggingIn = ref(false);
const session = ref<ConnectSession>();
const connection = ref("Disconnected");
const conversations = shallowRef<Conversation[]>([]);
const activeChannel = ref<Channel>();
const messages = shallowRef<Message[]>([]);
const channelID = ref("");
const channelType = ref(ChannelTypePerson);
const draft = ref("");
const loadingHistory = ref(false);
const historyFinished = ref(false);
const chatElement = ref<HTMLElement>();
let viewGeneration = 0;
let listenersInstalled = false;

const activeTitle = computed(() => {
  if (!activeChannel.value) return "Select or open a conversation";
  return `${activeChannel.value.channelType === ChannelTypeGroup ? "Group" : "Direct"} · ${activeChannel.value.channelID}`;
});

const sortedConversations = computed(() =>
  [...conversations.value].sort((left, right) => right.timestamp - left.timestamp),
);

function channelKey(channel: Channel): string {
  return `${channel.channelType}:${channel.channelID}`;
}

function messageKey(message: Message): string {
  return message.messageID || message.clientMsgNo || `${message.fromUID}:${message.messageSeq}`;
}

function messageText(message?: Message): string {
  if (!message) return "";
  if (message.streamText !== undefined) return message.streamText || "...";
  if (typeof message.content?.text === "string") return message.content.text;
  return "[Unsupported message]";
}

function messageTime(message: Message): string {
  if (!message.timestamp) return "";
  return new Date(message.timestamp * 1000).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isOwnMessage(message: Message): boolean {
  return message.fromUID === session.value?.uid || message.send;
}

function scrollToBottom(): void {
  nextTick(() => {
    if (chatElement.value) chatElement.value.scrollTop = chatElement.value.scrollHeight;
  });
}

function mergeMessages(current: Message[], incoming: Message[]): Message[] {
  const merged = new Map(current.map((message) => [messageKey(message), message]));
  for (const message of incoming) merged.set(messageKey(message), message);
  return [...merged.values()].sort(
    (left, right) => left.messageSeq - right.messageSeq || left.timestamp - right.timestamp,
  );
}

function upsertConversation(conversation: Conversation): void {
  const key = channelKey(conversation.channel);
  conversations.value = [
    conversation,
    ...conversations.value.filter((item) => channelKey(item.channel) !== key),
  ];
}

const connectStatusListener: ConnectStatusListener = (status, reasonCode) => {
  if (status === ConnectStatus.Connected) {
    connection.value = "Connected";
    void syncConversations();
  } else if (status === ConnectStatus.Connecting) {
    connection.value = "Connecting";
  } else if (status === ConnectStatus.ConnectFail && reasonCode === 2) {
    connection.value = "Authentication failed";
  } else {
    connection.value = "Disconnected";
  }
};

const conversationListener: ConversationListener = (conversation, action) => {
  if (action === ConversationAction.remove) {
    const key = channelKey(conversation.channel);
    conversations.value = conversations.value.filter((item) => channelKey(item.channel) !== key);
    return;
  }
  upsertConversation(conversation);
};

const messageListener: MessageListener = (message) => {
  if (activeChannel.value?.isEqual(message.channel)) {
    messages.value = mergeMessages(messages.value, [message]);
    scrollToBottom();
  }
};

const eventListener: WKEventListener = (event: WKEvent) => {
  const data = event.dataJson as Record<string, any> | undefined;
  if (!data) return;

  const existing = messages.value.find((message) => {
    const key = String(data.client_msg_no || data.clientMsgNo || data.stream_no || data.streamNo || data.id || "");
    return message.clientMsgNo === key || message.messageID === key;
  });
  const update = parseStreamEvent(event.type, data, existing?.streamText || "");
  if (!update) return;

  if (existing) {
    const changed = Object.assign(new Message(), existing);
    changed.streamText = update.text;
    changed.content = new MessageText(update.text || "...");
    messages.value = messages.value.map((message) => message === existing ? changed : message);
    scrollToBottom();
    return;
  }

  const channel = new Channel(
    String(data.channel_id || data.channelId || ""),
    Number(data.channel_type || data.channelType || 0),
  );
  if (!channel.channelID || !activeChannel.value?.isEqual(channel)) return;

  const message = new Message();
  message.clientMsgNo = update.key;
  message.fromUID = String(data.from_uid || data.fromUID || "");
  message.channel = channel;
  message.timestamp = Math.floor(Date.now() / 1000);
  message.streamText = update.text;
  message.content = new MessageText(update.text || "...");
  messages.value = mergeMessages(messages.value, [message]);
  scrollToBottom();
};

function installListeners(): void {
  if (listenersInstalled) return;
  const sdk = WKSDK.shared();
  sdk.connectManager.addConnectStatusListener(connectStatusListener);
  sdk.conversationManager.addConversationListener(conversationListener);
  sdk.chatManager.addMessageListener(messageListener);
  sdk.eventManager.addEventListener(eventListener);
  listenersInstalled = true;
}

function removeListeners(): void {
  if (!listenersInstalled) return;
  const sdk = WKSDK.shared();
  sdk.connectManager.removeConnectStatusListener(connectStatusListener);
  sdk.conversationManager.removeConversationListener(conversationListener);
  sdk.chatManager.removeMessageListener(messageListener);
  sdk.eventManager.removeEventListener(eventListener);
  listenersInstalled = false;
}

async function login(): Promise<void> {
  loginError.value = "";
  loggingIn.value = true;
  try {
    const nextSession = await createSession(username.value.trim(), password.value);
    session.value = nextSession;
    const sdk = configureSDK(nextSession);
    installListeners();
    connection.value = "Connecting";
    sdk.connect();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Login failed";
  } finally {
    loggingIn.value = false;
  }
}

async function syncConversations(): Promise<void> {
  try {
    conversations.value = await WKSDK.shared().conversationManager.sync();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Conversation sync failed";
  }
}

async function openChannel(channel: Channel): Promise<void> {
  viewGeneration += 1;
  const generation = viewGeneration;
  activeChannel.value = channel;
  messages.value = [];
  historyFinished.value = false;
  loadingHistory.value = true;
  WKSDK.shared().conversationManager.openConversation =
    WKSDK.shared().conversationManager.findConversation(channel) ||
    WKSDK.shared().conversationManager.createEmptyConversation(channel);

  try {
    const history = await WKSDK.shared().chatManager.syncMessages(channel, {
      limit: 30,
      startMessageSeq: 0,
      endMessageSeq: 0,
      pullMode: PullMode.Up,
    });
    if (generation !== viewGeneration) return;
    messages.value = mergeMessages([], history);
    historyFinished.value = history.length < 30;
    scrollToBottom();
  } catch (error) {
    if (generation === viewGeneration) {
      loginError.value = error instanceof Error ? error.message : "Message history failed";
    }
  } finally {
    if (generation === viewGeneration) loadingHistory.value = false;
  }
}

function openTypedChannel(): void {
  const id = channelID.value.trim();
  if (!id) return;
  void openChannel(new Channel(id, channelType.value));
  channelID.value = "";
}

async function loadEarlier(): Promise<void> {
  const channel = activeChannel.value;
  const first = messages.value[0];
  if (!channel || !first || loadingHistory.value || historyFinished.value) return;

  const generation = viewGeneration;
  loadingHistory.value = true;
  try {
    const history = await WKSDK.shared().chatManager.syncMessages(channel, {
      limit: 30,
      startMessageSeq: Math.max(0, first.messageSeq - 1),
      endMessageSeq: 0,
      pullMode: PullMode.Down,
    });
    if (generation !== viewGeneration) return;
    messages.value = mergeMessages(history, messages.value);
    historyFinished.value = history.length < 30 || first.messageSeq <= 1;
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Message history failed";
  } finally {
    if (generation === viewGeneration) loadingHistory.value = false;
  }
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  const channel = activeChannel.value;
  if (!text || !channel || connection.value !== "Connected") return;

  draft.value = "";
  try {
    const message = await WKSDK.shared().chatManager.send(new MessageText(text), channel);
    messages.value = mergeMessages(messages.value, [message]);
    scrollToBottom();
  } catch (error) {
    draft.value = text;
    loginError.value = error instanceof Error ? error.message : "Message send failed";
  }
}

function logout(): void {
  viewGeneration += 1;
  removeListeners();
  WKSDK.shared().disconnect();
  WKSDK.shared().conversationManager.openConversation = undefined;
  session.value = undefined;
  conversations.value = [];
  activeChannel.value = undefined;
  messages.value = [];
  password.value = "";
  connection.value = "Disconnected";
  loginError.value = "";
}

onBeforeUnmount(logout);
</script>

<template>
  <main v-if="!session" class="login-page">
    <form class="login-panel" @submit.prevent="login">
      <div class="brand-mark">N</div>
      <div>
        <p class="eyebrow">NucleAgent IM</p>
        <h1>Sign in to chat</h1>
      </div>
      <label>
        Username
        <input v-model="username" autocomplete="username" required autofocus>
      </label>
      <label>
        Password
        <input v-model="password" type="password" autocomplete="current-password" required>
      </label>
      <p v-if="loginError" class="error" role="alert">{{ loginError }}</p>
      <button class="primary" type="submit" :disabled="loggingIn">
        {{ loggingIn ? "Signing in..." : "Sign in" }}
      </button>
    </form>
  </main>

  <main v-else class="app-shell">
    <aside class="sidebar">
      <header class="sidebar-header">
        <div>
          <strong>NucleAgent IM</strong>
          <span :class="{ online: connection === 'Connected' }">{{ connection }}</span>
        </div>
        <button class="quiet" type="button" @click="logout">Log out</button>
      </header>

      <form class="channel-form" @submit.prevent="openTypedChannel">
        <input v-model="channelID" aria-label="Channel ID" placeholder="User or group ID" required>
        <select v-model.number="channelType" aria-label="Conversation type">
          <option :value="ChannelTypePerson">Direct</option>
          <option :value="ChannelTypeGroup">Group</option>
        </select>
        <button class="primary" type="submit">Open</button>
      </form>

      <div class="conversation-list">
        <button
          v-for="conversation in sortedConversations"
          :key="channelKey(conversation.channel)"
          class="conversation"
          :class="{ active: activeChannel?.isEqual(conversation.channel) }"
          type="button"
          @click="openChannel(conversation.channel)"
        >
          <span class="avatar">{{ conversation.channel.channelType === ChannelTypeGroup ? "#" : "@" }}</span>
          <span class="conversation-copy">
            <strong>{{ conversation.channel.channelID }}</strong>
            <small>{{ messageText(conversation.lastMessage) || "No messages yet" }}</small>
          </span>
          <span v-if="conversation.unread" class="unread">{{ conversation.unread }}</span>
        </button>
        <p v-if="!sortedConversations.length" class="empty-list">No recent conversations</p>
      </div>
    </aside>

    <section class="chat">
      <header class="chat-header">
        <div>
          <h2>{{ activeTitle }}</h2>
          <span v-if="activeChannel">{{ activeChannel.channelType === ChannelTypeGroup ? "Group chat" : "Direct message" }}</span>
        </div>
      </header>

      <div v-if="!activeChannel" class="empty-chat">
        <div class="empty-icon">@</div>
        <h2>Open a conversation</h2>
        <p>Choose a recent chat or enter a user or group ID.</p>
      </div>

      <template v-else>
        <div ref="chatElement" class="messages">
          <button
            v-if="messages.length && !historyFinished"
            class="load-earlier"
            type="button"
            :disabled="loadingHistory"
            @click="loadEarlier"
          >
            {{ loadingHistory ? "Loading..." : "Load earlier messages" }}
          </button>
          <p v-if="loadingHistory && !messages.length" class="loading">Loading messages...</p>
          <p v-else-if="!messages.length" class="loading">No messages yet</p>
          <article
            v-for="message in messages"
            :key="messageKey(message)"
            class="message"
            :class="{ own: isOwnMessage(message) }"
          >
            <span class="sender">{{ isOwnMessage(message) ? "You" : message.fromUID }}</span>
            <div class="bubble">{{ messageText(message) }}</div>
            <time>{{ messageTime(message) }}</time>
          </article>
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <textarea
            v-model="draft"
            aria-label="Message"
            placeholder="Write a message"
            rows="2"
            @keydown.enter.exact.prevent="sendMessage"
          />
          <button class="primary" type="submit" :disabled="!draft.trim() || connection !== 'Connected'">
            Send
          </button>
        </form>
      </template>
    </section>

    <p v-if="loginError" class="toast" role="alert" @click="loginError = ''">{{ loginError }}</p>
  </main>
</template>

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
import {
  createSession,
  endSession,
  getGroupMembers,
  imBase,
  listGroups,
  refreshSession,
  type ConnectSession,
  type Contact,
  type GroupMember,
  type IMGroup,
} from "./api";
import {
  completePortalLogin,
  isCallbackPath,
  readCallback,
  startPortalLogin,
} from "./portal";
import ContactPicker from "./components/ContactPicker.vue";
import GroupDialog from "./components/GroupDialog.vue";
import { configureSDK } from "./im";
import { buildOutgoingText } from "./mentions";
import { isAgentRelayed, readProvenance, rejectionCopy } from "./provenance";
import {
  applyAgentStreamEvent,
  browserStreamChannelId,
  connectAgentStream,
  parseStreamEvent,
  reconcileLiveResponses,
  type LiveAgentResponse,
  type StreamConnectionState,
} from "./stream";

const username = ref("");
const password = ref("");
const loginError = ref("");
const loggingIn = ref(false);
const session = ref<ConnectSession>();
const connection = ref("Disconnected");
const conversations = shallowRef<Conversation[]>([]);
const groups = ref<IMGroup[]>([]);
const knownContacts = ref<Contact[]>([]);
const activeChannel = ref<Channel>();
const activeGroupMembers = ref<GroupMember[]>([]);
const messages = shallowRef<Message[]>([]);
const liveResponses = ref<LiveAgentResponse[]>([]);
const streamConnection = ref<StreamConnectionState>("connected");
const draft = ref("");
const mentionedAgentUids = ref<string[]>([]);
const loadingHistory = ref(false);
const historyFinished = ref(false);
const chatElement = ref<HTMLElement>();
const groupDialogOpen = ref(false);
const dialogGroup = ref<IMGroup>();
let viewGeneration = 0;
let listenersInstalled = false;
let streamAbort: AbortController | undefined;

const activeGroup = computed(() =>
  activeChannel.value?.channelType === ChannelTypeGroup
    ? groups.value.find((group) => group.wukongChannelId === activeChannel.value?.channelID)
    : undefined,
);
const activeAgents = computed(() =>
  activeGroupMembers.value.filter((member) => member.accountType === "agent"),
);
const activeTitle = computed(() => {
  const channel = activeChannel.value;
  if (!channel) return "Select or open a conversation";
  if (channel.channelType === ChannelTypeGroup) {
    return activeGroup.value?.title || `Group ${channel.channelID}`;
  }
  const contact = knownContacts.value.find((item) => String(item.id) === channel.channelID);
  return contact?.displayName || contact?.username || `Direct ${channel.channelID}`;
});
const sortedConversations = computed(() =>
  [...conversations.value].sort((left, right) => right.timestamp - left.timestamp),
);
const busy = computed(() => liveResponses.value.some((response) => response.status === "busy"));
const mentionQuery = computed(() => {
  if (activeChannel.value?.channelType !== ChannelTypeGroup) return null;
  const match = draft.value.match(/(?:^|\s)@([^@\s]*)$/);
  return match ? match[1].toLocaleLowerCase() : null;
});
const mentionSuggestions = computed(() => {
  if (mentionQuery.value === null) return [];
  return activeAgents.value.filter((agent) => {
    const name = `${agent.displayName} ${agent.username}`.toLocaleLowerCase();
    return name.includes(mentionQuery.value!);
  });
});

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

function conversationTitle(conversation: Conversation): string {
  const channel = conversation.channel;
  if (channel.channelType === ChannelTypeGroup) {
    return groups.value.find((group) => group.wukongChannelId === channel.channelID)?.title
      || channel.channelID;
  }
  const contact = knownContacts.value.find((item) => String(item.id) === channel.channelID);
  return contact?.displayName || contact?.username || channel.channelID;
}

function agentName(uid: string): string {
  const member = activeGroupMembers.value.find((item) => String(item.uid) === uid);
  const contact = knownContacts.value.find((item) => String(item.id) === uid);
  return member?.displayName || member?.username || contact?.displayName || contact?.username || "Agent";
}

function isAgentMessage(message: Message): boolean {
  return activeGroupMembers.value.some(
    (member) => String(member.uid) === message.fromUID && member.accountType === "agent",
  );
}

/** "via @agentA" when this answer was triggered by another agent rather than a human. */
function relayLabel(message: Message): string {
  const provenance = readProvenance(message.content);
  if (!isAgentRelayed(provenance)) return "";
  return `via @${agentName(provenance!.viaUid)}`;
}

function rememberContact(contact: Contact): void {
  knownContacts.value = [
    contact,
    ...knownContacts.value.filter((item) => item.id !== contact.id),
  ];
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

function reconcileResponses(): void {
  liveResponses.value = reconcileLiveResponses(
    liveResponses.value,
    messages.value.map((message) => message.clientMsgNo).filter(Boolean),
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
    void Promise.all([syncConversations(), syncGroups()]);
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
    reconcileResponses();
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

// Local password and portal SSO converge here: both hold the same local envelope
// plus IM connect token, so the connect/listener startup is identical.
function startSession(nextSession: ConnectSession): void {
  session.value = nextSession;
  const sdk = configureSDK(nextSession);
  installListeners();
  connection.value = "Connecting";
  sdk.connect();
}

async function login(): Promise<void> {
  loginError.value = "";
  loggingIn.value = true;
  try {
    startSession(await createSession(username.value.trim(), password.value));
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Login failed";
  } finally {
    loggingIn.value = false;
  }
}

// Step 1 of the portal handoff: ask auth for a login URL and hand the tab over.
async function portalLogin(): Promise<void> {
  loginError.value = "";
  loggingIn.value = true;
  try {
    window.location.assign(await startPortalLogin());
  } catch (error) {
    loginError.value = error instanceof Error
      ? error.message
      : "Enterprise sign-in is unavailable";
    loggingIn.value = false;
  }
}

// Steps 2-4: the portal redirected back to /auth/portal. Read and scrub the
// credential before any await, then exchange it for a local session. Every
// failure path must land on the login form with a message, never a blank page.
async function resumePortalLogin(): Promise<void> {
  if (!isCallbackPath(window.location)) return;
  const callback = readCallback(window.location, window.history);
  if (!callback) {
    loginError.value = "Enterprise sign-in was cancelled or the link expired. Try again.";
    return;
  }
  loggingIn.value = true;
  try {
    startSession(await completePortalLogin(callback));
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Enterprise sign-in failed";
  } finally {
    loggingIn.value = false;
  }
}

void resumePortalLogin();

async function syncConversations(): Promise<void> {
  try {
    conversations.value = await WKSDK.shared().conversationManager.sync();
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Conversation sync failed";
  }
}

async function syncGroups(): Promise<void> {
  if (!session.value) return;
  try {
    groups.value = await listGroups(session.value);
    const channel = activeChannel.value;
    const group = groups.value.find((item) => item.wukongChannelId === channel?.channelID);
    if (channel?.channelType === ChannelTypeGroup && group && !activeGroupMembers.value.length) {
      await loadActiveGroupMembers(group, viewGeneration);
    }
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Groups could not be loaded";
  }
}

async function loadActiveGroupMembers(group: IMGroup, generation: number): Promise<void> {
  if (!session.value) return;
  try {
    const data = await getGroupMembers(group.id, session.value);
    if (generation === viewGeneration) activeGroupMembers.value = data.members;
  } catch (error) {
    if (generation === viewGeneration) {
      loginError.value = error instanceof Error ? error.message : "Group members could not be loaded";
    }
  }
}

function startAgentStream(channel: Channel, generation: number): void {
  streamAbort?.abort();
  liveResponses.value = [];
  streamConnection.value = "connected";
  if (!session.value) return;

  streamAbort = new AbortController();
  void connectAgentStream({
    baseUrl: imBase,
    channelId: browserStreamChannelId(channel.channelID, channel.channelType, session.value.uid),
    channelType: channel.channelType,
    jwt: session.value.jwt,
    signal: streamAbort.signal,
    async refreshToken() {
      const next = await refreshSession();
      // Keep the rest of the app on the rotated credentials, not just this stream.
      session.value = next;
      return next.jwt;
    },
    onConnectionChange(state) {
      if (generation === viewGeneration) streamConnection.value = state;
    },
    onEvent(event) {
      if (generation !== viewGeneration) return;
      liveResponses.value = applyAgentStreamEvent(liveResponses.value, event);
      reconcileResponses();
      scrollToBottom();
    },
  });
}

function retryAgentStream(): void {
  const channel = activeChannel.value;
  if (channel) startAgentStream(channel, viewGeneration);
}

async function openChannel(channel: Channel): Promise<void> {
  viewGeneration += 1;
  const generation = viewGeneration;
  activeChannel.value = channel;
  activeGroupMembers.value = [];
  messages.value = [];
  draft.value = "";
  mentionedAgentUids.value = [];
  historyFinished.value = false;
  loadingHistory.value = true;
  startAgentStream(channel, generation);
  WKSDK.shared().conversationManager.openConversation =
    WKSDK.shared().conversationManager.findConversation(channel)
    || WKSDK.shared().conversationManager.createEmptyConversation(channel);

  const group = groups.value.find((item) => item.wukongChannelId === channel.channelID);
  if (channel.channelType === ChannelTypeGroup && group) {
    void loadActiveGroupMembers(group, generation);
  }

  try {
    const history = await WKSDK.shared().chatManager.syncMessages(channel, {
      limit: 30,
      startMessageSeq: 0,
      endMessageSeq: 0,
      pullMode: PullMode.Up,
    });
    if (generation !== viewGeneration) return;
    messages.value = mergeMessages([], history);
    reconcileResponses();
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

function openContact(contact: Contact): void {
  rememberContact(contact);
  void openChannel(new Channel(String(contact.id), ChannelTypePerson));
}

function openGroup(group: IMGroup): void {
  void openChannel(new Channel(group.wukongChannelId, ChannelTypeGroup));
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
    reconcileResponses();
    historyFinished.value = history.length < 30 || first.messageSeq <= 1;
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "Message history failed";
  } finally {
    if (generation === viewGeneration) loadingHistory.value = false;
  }
}

function insertMention(agent: GroupMember): void {
  const name = agent.displayName || agent.username;
  draft.value = draft.value.replace(/@[^@\s]*$/, `@${name} `);
  const uid = String(agent.uid);
  if (!mentionedAgentUids.value.includes(uid)) {
    mentionedAgentUids.value = [...mentionedAgentUids.value, uid];
  }
}

function removeMention(uid: string): void {
  mentionedAgentUids.value = mentionedAgentUids.value.filter((item) => item !== uid);
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  const channel = activeChannel.value;
  if (!text || !channel || connection.value !== "Connected") return;

  const mentionUids = mentionedAgentUids.value;
  draft.value = "";
  mentionedAgentUids.value = [];
  try {
    const content = buildOutgoingText(text, channel.channelType, mentionUids);
    const message = await WKSDK.shared().chatManager.send(content, channel);
    messages.value = mergeMessages(messages.value, [message]);
    scrollToBottom();
  } catch (error) {
    draft.value = text;
    mentionedAgentUids.value = mentionUids;
    loginError.value = error instanceof Error ? error.message : "Message send failed";
  }
}

function showCreateGroup(): void {
  dialogGroup.value = undefined;
  groupDialogOpen.value = true;
}

function showGroupDetails(): void {
  if (!activeGroup.value) return;
  dialogGroup.value = activeGroup.value;
  groupDialogOpen.value = true;
}

function groupCreated(group: IMGroup): void {
  groups.value = [group, ...groups.value.filter((item) => item.id !== group.id)];
  groupDialogOpen.value = false;
  openGroup(group);
}

function groupRemoved(group: IMGroup): void {
  groups.value = groups.value.filter((item) => item.id !== group.id);
  groupDialogOpen.value = false;
  if (activeChannel.value?.channelID === group.wukongChannelId) {
    viewGeneration += 1;
    streamAbort?.abort();
    WKSDK.shared().conversationManager.openConversation = undefined;
    activeChannel.value = undefined;
    messages.value = [];
    liveResponses.value = [];
  }
}

async function groupChanged(): Promise<void> {
  await syncGroups();
  const group = activeGroup.value;
  if (group) await loadActiveGroupMembers(group, viewGeneration);
}

function teardownSession(): void {
  viewGeneration += 1;
  streamAbort?.abort();
  removeListeners();
  WKSDK.shared().disconnect();
  WKSDK.shared().conversationManager.openConversation = undefined;
  session.value = undefined;
  conversations.value = [];
  groups.value = [];
  knownContacts.value = [];
  activeChannel.value = undefined;
  activeGroupMembers.value = [];
  messages.value = [];
  liveResponses.value = [];
  password.value = "";
  connection.value = "Disconnected";
  loginError.value = "";
}

// Signing out must also revoke the refresh family server-side, or the HttpOnly
// cookie could resume the session. Local state drops immediately either way, so
// a failed revoke cannot strand the user in a logged-in UI.
function logout(): void {
  void endSession();
  teardownSession();
}

// Unmount is app teardown (reload, HMR), not an intentional sign-out, so it
// releases the connection without revoking the session.
onBeforeUnmount(teardownSession);
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
      <div class="login-actions">
        <button class="primary" type="submit" :disabled="loggingIn">
          {{ loggingIn ? "Signing in..." : "Sign in" }}
        </button>
        <button class="quiet" type="button" :disabled="loggingIn" @click="portalLogin">
          企业账号登录
        </button>
      </div>
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

      <div class="sidebar-tools">
        <ContactPicker :session="session" @select="openContact" />
        <button class="quiet new-group" type="button" @click="showCreateGroup">New group</button>
      </div>

      <nav class="conversation-list" aria-label="Conversations">
        <section v-if="groups.length" class="sidebar-section">
          <h2>Groups</h2>
          <button
            v-for="group in groups"
            :key="group.id"
            class="conversation"
            :class="{ active: activeChannel?.channelID === group.wukongChannelId }"
            type="button"
            @click="openGroup(group)"
          >
            <span class="avatar">#</span>
            <span class="conversation-copy">
              <strong>{{ group.title }}</strong>
              <small>Group chat</small>
            </span>
          </button>
        </section>

        <section class="sidebar-section">
          <h2>Recent</h2>
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
              <strong>{{ conversationTitle(conversation) }}</strong>
              <small>{{ messageText(conversation.lastMessage) || "No messages yet" }}</small>
            </span>
            <span v-if="conversation.unread" class="unread">{{ conversation.unread }}</span>
          </button>
          <p v-if="!sortedConversations.length" class="empty-list">No recent conversations</p>
        </section>
      </nav>
    </aside>

    <section class="chat">
      <header class="chat-header">
        <div>
          <h2>{{ activeTitle }}</h2>
          <span v-if="activeChannel">
            {{ activeChannel.channelType === ChannelTypeGroup ? "Group chat" : "Direct message" }}
          </span>
        </div>
        <div class="chat-actions">
          <span v-if="busy" class="busy-chip">Agent responding</span>
          <button v-if="activeGroup" class="quiet" type="button" @click="showGroupDetails">
            Members
          </button>
        </div>
      </header>

      <div v-if="!activeChannel" class="empty-chat">
        <div class="empty-icon">@</div>
        <h2>Open a conversation</h2>
        <p>Search for a person or agent, or choose a group.</p>
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
          <p v-else-if="!messages.length && !liveResponses.length" class="loading">No messages yet</p>
          <article
            v-for="message in messages"
            :key="messageKey(message)"
            class="message"
            :class="{ own: isOwnMessage(message) }"
          >
            <span class="sender">
              {{ isOwnMessage(message) ? "You" : message.fromUID }}
              <span v-if="isAgentMessage(message)" class="agent-badge">Agent</span>
              <span v-if="relayLabel(message)" class="relay-badge">{{ relayLabel(message) }}</span>
            </span>
            <div class="bubble">{{ messageText(message) }}</div>
            <time>{{ messageTime(message) }}</time>
          </article>
          <template v-for="response in liveResponses" :key="response.sourceKey">
            <p v-if="response.status === 'error'" class="stream-error" role="status">
              {{ rejectionCopy(response.code || "") }}
            </p>
            <article v-else class="message streaming">
              <span class="sender">
                {{ agentName(response.agentUid) }}
                <span class="agent-badge">Agent</span>
              </span>
              <div class="bubble">{{ response.text || "..." }}</div>
            </article>
          </template>
          <p v-if="streamConnection === 'reconnecting'" class="stream-state" role="status">
            Reconnecting live response...
          </p>
          <p v-else-if="streamConnection === 'disconnected'" class="stream-state" role="alert">
            连接已断开，
            <button class="link" type="button" @click="retryAgentStream">点击重连</button>
          </p>
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <div class="composer-input">
            <div v-if="mentionedAgentUids.length" class="mention-chips">
              <button
                v-for="uid in mentionedAgentUids"
                :key="uid"
                class="selection"
                type="button"
                :aria-label="`Remove mention ${agentName(uid)}`"
                @click="removeMention(uid)"
              >
                @{{ agentName(uid) }} <span aria-hidden="true">×</span>
              </button>
            </div>
            <div v-if="mentionSuggestions.length" class="mention-menu" role="listbox">
              <button
                v-for="agent in mentionSuggestions"
                :key="agent.uid"
                type="button"
                role="option"
                @click="insertMention(agent)"
              >
                <strong>{{ agent.displayName || agent.username }}</strong>
                <span>Agent</span>
              </button>
            </div>
            <textarea
              v-model="draft"
              aria-label="Message"
              :placeholder="activeAgents.length ? 'Write a message, type @ to mention an agent' : 'Write a message'"
              rows="2"
              @keydown.enter.exact.prevent="sendMessage"
            />
          </div>
          <button class="primary" type="submit" :disabled="!draft.trim() || connection !== 'Connected'">
            Send
          </button>
        </form>
      </template>
    </section>

    <GroupDialog
      v-if="groupDialogOpen"
      :session="session"
      :group="dialogGroup"
      @close="groupDialogOpen = false"
      @created="groupCreated"
      @changed="groupChanged"
      @removed="groupRemoved"
    />
    <p v-if="loginError" class="toast" role="alert" @click="loginError = ''">{{ loginError }}</p>
  </main>
</template>

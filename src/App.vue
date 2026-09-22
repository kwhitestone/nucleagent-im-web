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
  imSession,
  listGroups,
  refreshSession,
  type ConnectSession,
  type Contact,
  type GroupMember,
  type IMGroup,
} from "./api";
import {
  clearCachedContacts,
  contactsFromMembers,
  isDialableUid,
  loadCachedContacts,
  mergeContacts,
  resolveContactName,
  saveCachedContacts,
} from "./contacts";
import {
  completePortalLogin,
  isCallbackPath,
  readCallback,
  startPortalLogin,
} from "./portal";
import { installShellBridge, isInShell } from "./shell";
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

// Framed by the nucleagent-web shell: the shell owns login/logout and pushes the
// access token. Standalone (the default) keeps every existing behaviour.
const embedded = isInShell();
const username = ref("");
const password = ref("");
const loginError = ref("");
const loggingIn = ref(false);
const session = ref<ConnectSession>();
const connection = ref("Disconnected");
const conversations = shallowRef<Conversation[]>([]);
const groups = ref<IMGroup[]>([]);
// Populated in startSession once the uid is known: the cache is per-account, so there is
// nothing meaningful to read before then.
const knownContacts = ref<Contact[]>([]);
// Boot restore runs before the login form renders, so the form never flashes for a user
// whose refresh cookie is still good.
const restoring = ref(!embedded && !isCallbackPath(window.location));
const dialOpen = ref(false);
const dialUid = ref("");
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
  return contactName(channel.channelID) || `Direct ${channel.channelID}`;
});
const dialUidValid = computed(() => isDialableUid(dialUid.value));
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
  return contactName(channel.channelID) || channel.channelID;
}

function agentName(uid: string): string {
  const member = activeGroupMembers.value.find((item) => String(item.uid) === uid);
  return member?.displayName || member?.username || contactName(uid) || "Agent";
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

function remember(contacts: Contact[]): void {
  const uid = session.value?.uid;
  if (!uid) return;
  knownContacts.value = mergeContacts(knownContacts.value, contacts);
  saveCachedContacts(uid, knownContacts.value);
}

function rememberContact(contact: Contact): void {
  remember([contact]);
}

function contactName(uid: string): string | undefined {
  return resolveContactName(knownContacts.value, uid);
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
  // Names cached by this account on this browser, so a reload renders them instead of
  // raw UIDs. Reading it here (not at module scope) keeps one account's names out of
  // another's session when the shell swaps users without a sign-out.
  knownContacts.value = loadCachedContacts(nextSession.uid);
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
// Embedded, the shell owns login instead — it holds the refresh cookie and the
// portal callback origin, so im-web just asks it to open its login modal.
async function portalLogin(): Promise<void> {
  loginError.value = "";
  if (embedded) {
    shellBridge.requestLogin();
    return;
  }
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
  // Embedded, the callback belongs to the shell's origin; im-web must not try
  // to consume one even if a stale /auth/portal URL is framed.
  if (embedded || !isCallbackPath(window.location)) return;
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

// Shell mode: the shell pushes the access token over the validated channel and
// im-web converges on the same connect-token exchange local login uses. Nothing
// else about the app changes, and standalone mode never reaches this bridge.
const shellBridge = installShellBridge({
  onAuth(intent) {
    if (!intent.token) {
      // Shell signed out (or bumped the version with no token): drop local state
      // without revoking anything ourselves — the shell owns the refresh family.
      // This is an intentional sign-out, so the per-account name cache goes too.
      if (session.value) {
        clearCachedContacts(session.value.uid);
        teardownSession();
      }
      return;
    }
    void adoptShellSession(intent.token);
  },
});

async function adoptShellSession(accessToken: string): Promise<void> {
  if (session.value?.jwt === accessToken) return;
  loginError.value = "";
  loggingIn.value = true;
  try {
    startSession(await imSession({ accessToken }));
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : "IM sign-in failed";
    shellBridge.reportAuthRequired("rejected");
  } finally {
    loggingIn.value = false;
  }
}

// The session lives in memory, but the HttpOnly refresh cookie outlives the document, so
// a reload can rebuild it without the user signing in again. This must not run when the
// SSO callback is mid-flight (that path is already minting a session and would rotate the
// same family twice) nor embedded (the shell owns the cookie and pushes a token instead).
async function restoreSession(): Promise<void> {
  if (!restoring.value) return;
  try {
    startSession(await refreshSession());
  } catch {
    // No cookie, expired, or a revoked family: the login form is the correct answer and
    // a failed restore is not an error worth showing.
  } finally {
    restoring.value = false;
  }
}

void resumePortalLogin();
void restoreSession();

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
    // Group members are the one server payload carrying names for UIDs we never searched.
    remember(contactsFromMembers(data.members));
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
      // Embedded, the refresh cookie lives on the shell's origin, not ours.
      // Report the rejection instead; the shell rotates and re-pushes an auth
      // intent, which lands in adoptShellSession and rebuilds the session.
      if (embedded) {
        shellBridge.reportAuthRequired("rejected");
        throw new Error("Shell owns the session refresh");
      }
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

// No endpoint resolves a UID to a name, so a dialled conversation shows the UID until that
// person is seen in a search or a shared group. Opening the channel is the whole feature.
function dialUidOpen(): void {
  if (!dialUidValid.value) return;
  const uid = dialUid.value.trim();
  dialUid.value = "";
  dialOpen.value = false;
  void openChannel(new Channel(uid, ChannelTypePerson));
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
  dialOpen.value = false;
  dialUid.value = "";
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
  // Embedded, the refresh cookie is on the shell's origin — revoking from here
  // would be a cross-origin no-op that leaves the shell still signed in. Ask the
  // shell to log out; its session bump pushes a null-token auth intent back,
  // which tears this child down through onAuth.
  // A sign-out drops this account's cached names. Unmount (reload/HMR) deliberately keeps
  // them — that is what lets a restored session still render names instead of raw UIDs.
  if (session.value) clearCachedContacts(session.value.uid);
  if (embedded) {
    shellBridge.requestLogout();
    teardownSession();
    return;
  }
  void endSession();
  teardownSession();
}

// Unmount is app teardown (reload, HMR), not an intentional sign-out, so it
// releases the connection without revoking the session.
onBeforeUnmount(() => {
  shellBridge.dispose();
  teardownSession();
});
</script>

<template>
  <!-- Embedded: the shell owns login, so no local form. Show progress while its
       auth intent is in flight, or a way back to the shell's modal if it fails. -->
  <main v-if="!session && embedded" class="login-page">
    <div class="login-panel">
      <div class="brand-mark">N</div>
      <div>
        <p class="eyebrow">NucleAgent IM</p>
        <h1>{{ loggingIn ? "Connecting..." : "Waiting for sign-in" }}</h1>
      </div>
      <p v-if="loginError" class="error" role="alert">{{ loginError }}</p>
      <div class="login-actions">
        <button class="primary" type="button" :disabled="loggingIn" @click="portalLogin">
          Sign in
        </button>
      </div>
    </div>
  </main>

  <!-- Restoring from the refresh cookie: hold the form back so a returning user does not
       see a login flash before the silent restore lands. -->
  <main v-else-if="!session && restoring" class="login-page">
    <div class="login-panel">
      <div class="brand-mark">N</div>
      <div>
        <p class="eyebrow">NucleAgent IM</p>
        <h1>正在恢复会话...</h1>
      </div>
    </div>
  </main>

  <main v-else-if="!session" class="login-page">
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
        <form v-if="dialOpen" class="uid-dial" @submit.prevent="dialUidOpen">
          <input
            v-model="dialUid"
            class="contact-search"
            inputmode="numeric"
            aria-label="按 UID 添加"
            placeholder="输入 UID"
            autocomplete="off"
            autofocus
          >
          <button class="primary" type="submit" :disabled="!dialUidValid">
            打开
          </button>
        </form>
        <button v-else class="quiet dial-uid" type="button" @click="dialOpen = true">
          按 UID 添加
        </button>
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

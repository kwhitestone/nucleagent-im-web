<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef } from "vue";
import { useI18n } from "vue-i18n";
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
import { installShellBridge, isInShell, shellAccountUrl } from "./shell";
import {
  clearCachedProfile,
  fetchProfile,
  loadCachedProfile,
  saveCachedProfile,
} from "./profile";
import ContactPicker from "./components/ContactPicker.vue";
import GroupDialog from "./components/GroupDialog.vue";
import IdentityCard from "./components/IdentityCard.vue";
import EmptyPaths from "./components/EmptyPaths.vue";
import SystemLine from "./components/SystemLine.vue";
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
const { t } = useI18n();
const username = ref("");
const password = ref("");
const loginError = ref("");
const loggingIn = ref(false);
const session = ref<ConnectSession>();
// Connection state is a key, not a sentence. It used to hold the English label
// itself, which both drove `sendMessage`'s guard and rendered in the header —
// translating it in place would have silently broken the guard.
type ConnectionState = "connected" | "connecting" | "disconnected" | "authFailed";
const connection = ref<ConnectionState>("disconnected");
// Which rail slot is selected. Purely a list filter; it never touches the SDK.
type RailMode = "all" | "groups" | "agents";
const railMode = ref<RailMode>("all");
const searchOpen = ref(false);
// This account's own display name, read from auth's user-info endpoint. Empty
// is the normal case for a portal account today: auth decodes only {id, openId}
// from the portal response and stores "Portal user <uid>", which profile.ts
// treats as absent. The identity card then shows its own fallback. See
// profile.ts for where the real name is stranded and what has to change.
const profileName = ref("");
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
  if (!channel) return t("empty.pickConversation");
  if (channel.channelType === ChannelTypeGroup) {
    return activeGroup.value?.title || `${t("chat.groupChat")} ${channel.channelID}`;
  }
  // Falls through to the raw UID on purpose: the row template pairs it with a
  // "no name yet" sub-line so a bare number never reads as a bug.
  return contactName(channel.channelID) || channel.channelID;
});
const dialUidValid = computed(() => isDialableUid(dialUid.value));
const sortedConversations = computed(() =>
  [...conversations.value].sort((left, right) => right.timestamp - left.timestamp),
);

/** UIDs of every agent this account has seen, so the rail can filter by them. */
const knownAgentUids = computed(
  () => new Set(
    knownContacts.value
      .filter((contact) => contact.accountType === "agent")
      .map((contact) => String(contact.id)),
  ),
);

// The rail filters the one list rather than fetching different ones: conversations
// already carry their channel type, so this is a view concern only.
const visibleConversations = computed(() => {
  if (railMode.value === "groups") {
    return sortedConversations.value.filter(
      (item) => item.channel.channelType === ChannelTypeGroup,
    );
  }
  if (railMode.value === "agents") {
    return sortedConversations.value.filter(
      (item) => item.channel.channelType === ChannelTypePerson
        && knownAgentUids.value.has(item.channel.channelID),
    );
  }
  return sortedConversations.value;
});

const totalUnread = computed(
  () => conversations.value.reduce((sum, item) => sum + (item.unread || 0), 0),
);

/** True only on a genuinely empty account, not on an empty filter result. */
const isFirstRun = computed(
  () => !sortedConversations.value.length && !groups.value.length,
);

const activeGroupMeta = computed(() => {
  const agents = activeAgents.value.length;
  return t("chat.groupMeta", {
    people: activeGroupMembers.value.length - agents,
    agents,
  });
});

const respondingAgent = computed(() => {
  const live = liveResponses.value.find((response) => response.status === "busy");
  return live ? agentName(live.agentUid) : "";
});

function conversationSubtitle(conversation: Conversation): string {
  const last = conversation.lastMessage;
  if (!last) return "";
  const body = messageText(last);
  if (isOwnMessage(last)) return `${t("list.you")} ${body}`;
  // Group previews name the speaker; a direct chat's speaker is already the row.
  if (conversation.channel.channelType === ChannelTypeGroup) {
    const who = contactName(last.fromUID);
    if (who) return `${who}: ${body}`;
  }
  return body;
}

/** True when a row shows a bare UID because no name has resolved yet. */
function isUnnamed(conversation: Conversation): boolean {
  return conversation.channel.channelType === ChannelTypePerson
    && !contactName(conversation.channel.channelID);
}

function isAgentConversation(conversation: Conversation): boolean {
  return conversation.channel.channelType === ChannelTypePerson
    && knownAgentUids.value.has(conversation.channel.channelID);
}

function conversationInitial(conversation: Conversation): string {
  if (conversation.channel.channelType === ChannelTypeGroup) return "#";
  const name = conversationTitle(conversation);
  return isUnnamed(conversation) ? "?" : [...name][0]?.toUpperCase() || "?";
}

function conversationTime(conversation: Conversation): string {
  if (!conversation.timestamp) return "";
  const date = new Date(conversation.timestamp * 1000);
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  if (sameDay) {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return t("chat.yesterday");
  return date.toLocaleDateString([], { month: "numeric", day: "numeric" });
}

function focusSearch(): void {
  searchOpen.value = true;
  void nextTick(() => {
    document.querySelector<HTMLInputElement>(".sidebar-tools .contact-search")?.focus();
  });
}

function openDial(): void {
  dialOpen.value = true;
  searchOpen.value = true;
}
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
  return t("chat.unsupported");
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
  return member?.displayName || member?.username || contactName(uid) || t("badge.agent");
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
  return t("badge.via", { name: agentName(provenance!.viaUid) });
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
    connection.value = "connected";
    void Promise.all([syncConversations(), syncGroups()]);
  } else if (status === ConnectStatus.Connecting) {
    connection.value = "connecting";
  } else if (status === ConnectStatus.ConnectFail && reasonCode === 2) {
    connection.value = "authFailed";
  } else {
    connection.value = "disconnected";
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
  // Render the cached name immediately so a reload does not flash the UID
  // fallback, then refresh from the server behind it.
  profileName.value = loadCachedProfile(nextSession.uid)?.displayName || "";
  void loadProfile(nextSession);
  // Names cached by this account on this browser, so a reload renders them instead of
  // raw UIDs. Reading it here (not at module scope) keeps one account's names out of
  // another's session when the shell swaps users without a sign-out.
  knownContacts.value = loadCachedContacts(nextSession.uid);
  const sdk = configureSDK(nextSession);
  installListeners();
  connection.value = "connecting";
  sdk.connect();
}

// A failed profile read is not worth surfacing: the identity card falls back to
// "Portal user <uid>", and blocking or alarming the user over a display name
// they did not ask for would be worse than the missing name.
async function loadProfile(forSession: ConnectSession): Promise<void> {
  const profile = await fetchProfile(forSession);
  if (!profile || session.value?.uid !== forSession.uid) return;
  profileName.value = profile.displayName;
  saveCachedProfile(forSession.uid, profile);
}

async function login(): Promise<void> {
  loginError.value = "";
  loggingIn.value = true;
  try {
    startSession(await createSession(username.value.trim(), password.value));
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t("login.errFailed");
  } finally {
    loggingIn.value = false;
  }
}

// Step 1 of the portal handoff: ask auth for a login URL and hand the tab over.
// Standalone only: embedded runs render no login UI (see signInViaShell).
async function portalLogin(): Promise<void> {
  loginError.value = "";
  loggingIn.value = true;
  try {
    window.location.assign(await startPortalLogin());
  } catch (error) {
    loginError.value = error instanceof Error
      ? error.message
      : t("login.errSsoUnavailable");
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
    loginError.value = t("login.errCancelled");
    return;
  }
  loggingIn.value = true;
  try {
    startSession(await completePortalLogin(callback));
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t("login.errFailed");
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
        clearCachedProfile(session.value.uid);
        teardownSession();
      }
      signInViaShell();
      return;
    }
    void adoptShellSession(intent.token);
  },
});

// Embedded with no session: the shell's auth intent normally lands within a
// frame or two. If it has not after a short grace period (signed out, expired),
// ask the shell once to take the user to its /login.
const SHELL_LOGIN_GRACE_MS = 1500;
let shellLoginTimer: ReturnType<typeof setTimeout> | undefined;
function signInViaShell(): void {
  clearTimeout(shellLoginTimer);
  shellLoginTimer = setTimeout(() => {
    if (!session.value && !loggingIn.value) shellBridge.requestLogin();
  }, SHELL_LOGIN_GRACE_MS);
}
if (embedded) signInViaShell();

async function adoptShellSession(accessToken: string): Promise<void> {
  if (session.value?.jwt === accessToken) return;
  loginError.value = "";
  loggingIn.value = true;
  try {
    startSession(await imSession({ accessToken }));
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t("login.errFailed");
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
    loginError.value = error instanceof Error ? error.message : t("chat.errConversations");
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
    loginError.value = error instanceof Error ? error.message : t("chat.errGroups");
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
      loginError.value = error instanceof Error ? error.message : t("group.errMembers");
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
      loginError.value = error instanceof Error ? error.message : t("chat.errHistory");
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
    loginError.value = error instanceof Error ? error.message : t("chat.errHistory");
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
  if (!text || !channel || connection.value !== "connected") return;

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
    loginError.value = error instanceof Error ? error.message : t("composer.errSend");
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
  profileName.value = "";
  dialOpen.value = false;
  dialUid.value = "";
  activeChannel.value = undefined;
  activeGroupMembers.value = [];
  messages.value = [];
  liveResponses.value = [];
  password.value = "";
  connection.value = "disconnected";
  loginError.value = "";
}

// The identity card's "Account" action. im-web has no sign-out of its own: the
// shell's /account is the one logout for every site, and its session bump
// pushes a null-token auth intent that tears this child down through onAuth.
function openAccount(): void {
  if (embedded) {
    shellBridge.requestAccount();
    return;
  }
  window.location.assign(shellAccountUrl());
}

// Unmount is app teardown (reload, HMR), not an intentional sign-out, so it
// releases the connection without revoking the session.
onBeforeUnmount(() => {
  clearTimeout(shellLoginTimer);
  shellBridge.dispose();
  teardownSession();
});
</script>

<template>
  <!-- Embedded: the shell owns sign-in (its /login page), so no login UI here at
       all — only the interstitial while its auth push is in flight. -->
  <main v-if="!session && embedded" class="login-page" data-testid="im-embedded-wait">
    <div class="login-panel" role="status" aria-live="polite">
      <div class="brand-mark">N</div>
      <div>
        <p class="eyebrow">{{ t("app.title") }}</p>
        <h1>{{ loggingIn ? t("conn.connecting") : t("login.redirectingTitle") }}</h1>
      </div>
      <p v-if="!loggingIn">{{ t("login.redirectingBody") }}</p>
      <p class="typing" aria-hidden="true"><i /><i /><i /></p>
    </div>
  </main>

  <!-- Restoring from the refresh cookie: hold the form back so a returning user does not
       see a login flash before the silent restore lands. -->
  <main v-else-if="!session && restoring" class="login-page">
    <div class="login-panel">
      <div class="brand-mark">N</div>
      <div>
        <p class="eyebrow">{{ t("app.title") }}</p>
        <h1>{{ t("login.restoring") }}</h1>
      </div>
      <p class="typing" aria-hidden="true"><i /><i /><i /></p>
    </div>
  </main>

  <main v-else-if="!session" class="login-page">
    <form class="login-panel" @submit.prevent="login">
      <div class="brand-mark">N</div>
      <div>
        <p class="eyebrow">{{ t("app.title") }}</p>
        <h1>{{ t("login.subtitle") }}</h1>
      </div>

      <!-- SSO is the primary action: for an enterprise user it is the normal
           path. Local password stays available but stops being the headline. -->
      <button class="primary" type="button" :disabled="loggingIn" @click="portalLogin">
        {{ t("login.sso") }}
      </button>
      <p class="login-or"><span>{{ t("login.or") }}</span></p>

      <label>
        {{ t("login.username") }}
        <input v-model="username" autocomplete="username" required>
      </label>
      <label>
        {{ t("login.password") }}
        <input v-model="password" type="password" autocomplete="current-password" required>
      </label>
      <p v-if="loginError" class="error" role="alert">{{ loginError }}</p>
      <div class="login-actions">
        <button class="quiet" type="submit" :disabled="loggingIn">
          {{ loggingIn ? t("login.submitting") : t("login.submit") }}
        </button>
      </div>
    </form>
  </main>

  <!-- Variant B: 72px icon rail + conversation list + chat. This is the shell's
       own AppSidebar anatomy (brand / nav / list / user slot) split across two
       columns, so the mental model carries over between them. -->
  <main v-else class="app-shell" :class="{ 'show-chat': activeChannel }">
    <nav class="rail" :aria-label="t('app.title')">
      <span class="rail-brand" :title="t('app.title')">N</span>

      <button
        class="rail-btn"
        :class="{ active: railMode === 'all' }"
        type="button"
        :title="t('list.all')"
        :aria-label="t('list.all')"
        :aria-pressed="railMode === 'all'"
        @click="railMode = 'all'"
      >
        <span class="rail-glyph" aria-hidden="true">💬</span>
        <span v-if="totalUnread" class="rail-dot" />
      </button>
      <button
        class="rail-btn"
        :class="{ active: railMode === 'groups' }"
        type="button"
        :title="t('list.groups')"
        :aria-label="t('list.groups')"
        :aria-pressed="railMode === 'groups'"
        @click="railMode = 'groups'"
      >
        <span class="rail-glyph" aria-hidden="true">👥</span>
      </button>
      <!-- Agents get their own slot because that is the one thing this product
           has that a generic IM does not. -->
      <button
        class="rail-btn"
        :class="{ active: railMode === 'agents' }"
        type="button"
        :title="t('list.agents')"
        :aria-label="t('list.agents')"
        :aria-pressed="railMode === 'agents'"
        @click="railMode = 'agents'"
      >
        <span class="rail-glyph" aria-hidden="true">🤖</span>
      </button>
      <button
        class="rail-btn"
        type="button"
        :title="t('list.searchPlaceholder')"
        :aria-label="t('list.searchPlaceholder')"
        @click="focusSearch"
      >
        <span class="rail-glyph" aria-hidden="true">🔍</span>
      </button>

      <span class="rail-spacer" />
      <IdentityCard
        v-if="session"
        :uid="session.uid"
        :display-name="profileName"
        @account="openAccount"
      />
    </nav>

    <aside class="sidebar">
      <header class="sidebar-header">
        <div>
          <strong>{{ railMode === "all" ? t("list.all") : railMode === "groups" ? t("list.groups") : t("list.agents") }}</strong>
          <span :class="{ online: connection === 'connected' }">{{ t(`conn.${connection}`) }}</span>
        </div>
        <button
          class="icon-button"
          type="button"
          :title="t('group.create')"
          :aria-label="t('group.create')"
          @click="showCreateGroup"
        >
          +
        </button>
      </header>

      <div class="sidebar-tools">
        <ContactPicker
          :session="session"
          :placeholder="t('list.searchPlaceholder')"
          @select="openContact"
        />
        <form v-if="dialOpen" class="uid-dial" @submit.prevent="dialUidOpen">
          <input
            v-model="dialUid"
            class="contact-search"
            inputmode="numeric"
            :aria-label="t('empty.pathUid')"
            :placeholder="t('uid.dialPlaceholder')"
            autocomplete="off"
          >
          <button class="primary" type="submit" :disabled="!dialUidValid">
            {{ t("uid.open") }}
          </button>
        </form>
        <button v-else class="quiet dial-uid" type="button" @click="openDial">
          {{ t("empty.pathUid") }}
        </button>
      </div>

      <nav class="conversation-list" :aria-label="t('list.all')">
        <button
          v-for="conversation in visibleConversations"
          :key="channelKey(conversation.channel)"
          class="conversation"
          :class="{ active: activeChannel?.isEqual(conversation.channel) }"
          type="button"
          @click="openChannel(conversation.channel)"
        >
          <span
            class="avatar"
            :class="{
              group: conversation.channel.channelType === ChannelTypeGroup,
              bot: isAgentConversation(conversation),
              unnamed: isUnnamed(conversation),
            }"
          >{{ conversationInitial(conversation) }}</span>
          <span class="conversation-copy">
            <span class="conversation-name">
              <strong :class="{ mono: isUnnamed(conversation) }">
                {{ conversationTitle(conversation) }}
              </strong>
              <span v-if="isAgentConversation(conversation)" class="tag agent">
                {{ t("badge.agent") }}
              </span>
              <span v-else-if="isUnnamed(conversation)" class="tag uid">{{ t("badge.uid") }}</span>
            </span>
            <!-- A row that resolves to a bare UID says why, so the number does
                 not read as a broken name. -->
            <small>
              {{ isUnnamed(conversation) && !conversation.lastMessage
                ? t("list.noNameYet")
                : conversationSubtitle(conversation) || t("empty.noMessages") }}
            </small>
          </span>
          <span class="conversation-end">
            <span class="conversation-time">{{ conversationTime(conversation) }}</span>
            <span
              v-if="conversation.unread"
              class="unread"
              :aria-label="t('list.unreadLabel', { count: conversation.unread })"
            >{{ conversation.unread }}</span>
          </span>
        </button>

        <!-- Groups this account belongs to but has no conversation row for yet
             (never opened, so WuKongIM has nothing to sync). -->
        <template v-if="railMode !== 'agents'">
          <button
            v-for="group in groups.filter((item) => !conversations.some((c) => c.channel.channelID === item.wukongChannelId))"
            :key="group.id"
            class="conversation"
            :class="{ active: activeChannel?.channelID === group.wukongChannelId }"
            type="button"
            @click="openGroup(group)"
          >
            <span class="avatar group">#</span>
            <span class="conversation-copy">
              <span class="conversation-name"><strong>{{ group.title }}</strong></span>
              <small>{{ t("empty.noMessages") }}</small>
            </span>
          </button>
        </template>

        <p v-if="!visibleConversations.length && !groups.length && !isFirstRun" class="empty-list">
          {{ t("empty.noConversations") }}
        </p>
      </nav>
    </aside>

    <section class="chat">
      <header class="chat-header">
        <button
          v-if="activeChannel"
          class="icon-button back"
          type="button"
          :aria-label="t('list.all')"
          @click="activeChannel = undefined"
        >
          ‹
        </button>
        <div>
          <h2>{{ activeTitle }}</h2>
          <span v-if="activeChannel">
            {{ activeChannel.channelType === ChannelTypeGroup
              ? activeGroupMeta
              : t("chat.directMessage") }}
          </span>
        </div>
        <div class="chat-actions">
          <span v-if="busy" class="busy-chip">
            <span class="blip" aria-hidden="true" />
            {{ t("chat.responding", { name: respondingAgent || t("badge.agent") }) }}
          </span>
          <button v-if="activeGroup" class="quiet" type="button" @click="showGroupDetails">
            {{ t("chat.members") }}
          </button>
        </div>
      </header>

      <!-- A brand-new account gets the three paths instead of an empty shrug. -->
      <EmptyPaths
        v-if="!activeChannel && isFirstRun"
        @search="focusSearch"
        @dial="openDial"
        @group="showCreateGroup"
      />

      <div v-else-if="!activeChannel" class="empty-chat">
        <h2>{{ t("empty.pickConversation") }}</h2>
        <p>{{ t("empty.pickConversationSub") }}</p>
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
            {{ loadingHistory ? t("chat.loading") : t("chat.loadEarlier") }}
          </button>
          <p v-if="loadingHistory && !messages.length" class="loading">{{ t("chat.loading") }}</p>
          <p v-else-if="!messages.length && !liveResponses.length" class="loading">
            {{ t("empty.noMessages") }}
            <template v-if="activeChannel.channelType === ChannelTypeGroup">
              <br>{{ t("empty.noMessagesGroup") }}
            </template>
          </p>

          <article
            v-for="message in messages"
            :key="messageKey(message)"
            class="message"
            :class="{ own: isOwnMessage(message), agent: isAgentMessage(message) }"
          >
            <span class="sender">
              {{ isOwnMessage(message) ? t("chat.you") : (contactName(message.fromUID) || message.fromUID) }}
              <span v-if="isAgentMessage(message)" class="tag agent">{{ t("badge.agent") }}</span>
              <span v-if="relayLabel(message)" class="tag relay">{{ relayLabel(message) }}</span>
            </span>
            <div class="bubble">{{ messageText(message) }}</div>
            <time>{{ messageTime(message) }}</time>
          </article>

          <template v-for="response in liveResponses" :key="response.sourceKey">
            <!-- Belongs to this conversation, so it sits in the timeline rather
                 than as a corner toast that covers the composer. -->
            <SystemLine v-if="response.status === 'error'">
              {{ rejectionCopy(response.code || "") }}
            </SystemLine>
            <article v-else class="message agent streaming">
              <span class="sender">
                {{ agentName(response.agentUid) }}
                <span class="tag agent">{{ t("badge.agent") }}</span>
              </span>
              <div class="bubble">
                <span v-if="response.text">{{ response.text }}</span>
                <span v-else class="typing" aria-hidden="true"><i /><i /><i /></span>
              </div>
            </article>
          </template>

          <SystemLine v-if="streamConnection === 'reconnecting'" calm>
            {{ t("system.reconnecting") }}
          </SystemLine>
          <!-- Neutral, not red: a dropped stream heals itself. -->
          <SystemLine
            v-else-if="streamConnection === 'disconnected'"
            calm
            :action="t('system.reconnect')"
            @act="retryAgentStream"
          >
            {{ t("system.disconnected") }}
          </SystemLine>
        </div>

        <form class="composer" @submit.prevent="sendMessage">
          <div class="composer-input">
            <div v-if="mentionedAgentUids.length" class="mention-chips">
              <button
                v-for="uid in mentionedAgentUids"
                :key="uid"
                class="selection"
                type="button"
                :aria-label="t('composer.removeMention', { name: agentName(uid) })"
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
                <span>{{ t("badge.agent") }}</span>
              </button>
            </div>
            <textarea
              v-model="draft"
              :aria-label="t('composer.label')"
              :placeholder="activeAgents.length ? t('composer.placeholderAgents') : t('composer.placeholder')"
              rows="2"
              @keydown.enter.exact.prevent="sendMessage"
            />
          </div>
          <button
            class="primary send"
            type="submit"
            :disabled="!draft.trim() || connection !== 'connected'"
          >
            {{ t("composer.send") }}
          </button>
          <!-- Enter-to-send is a destructive default, so the UI states it. -->
          <p class="composer-hint">
            <span><kbd>Enter</kbd> {{ t("composer.hintSend") }}</span>
            <span><kbd>Shift</kbd>+<kbd>Enter</kbd> {{ t("composer.hintNewline") }}</span>
            <span v-if="activeAgents.length"><kbd>@</kbd> {{ t("composer.hintMention") }}</span>
          </p>
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
    <!-- Only genuinely global failures stay a toast; conversation-scoped ones
         became system lines above. -->
    <p v-if="loginError" class="toast" role="alert" @click="loginError = ''">{{ loginError }}</p>
  </main>
</template>

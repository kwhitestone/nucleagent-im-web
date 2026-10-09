<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
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
  provisionAddress,
  refreshSession,
  renewsSameUser,
  type ConnectSession,
  type Contact,
  type GroupMember,
  type IMGroup,
} from "./api";
import {
  clearCachedContacts,
  contactsFromMembers,
  isDialableOpenId,
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
import { resolveConversationTarget, type ConversationTarget } from "./conversationTarget";
import {
  clearCachedProfile,
  fetchProfile,
  loadCachedProfile,
  saveCachedProfile,
} from "./profile";
import { accountTypeOf, avatarFailed, avatarSrc, ensureNames, handleFor, isEnterprise, isMissing, nameFor, openIdOf, resetNames } from "./names";
import ContactPicker from "./components/ContactPicker.vue";
import GroupDialog from "./components/GroupDialog.vue";
import RowAvatar from "./components/RowAvatar.vue";
import IdentityCard from "./components/IdentityCard.vue";
import { profileActions, profileParams, useAccountPopover, type ProfileTarget } from "./accountPopover";
import { getLocale } from "./i18n";
import EmptyPaths from "./components/EmptyPaths.vue";
import SystemLine from "./components/SystemLine.vue";
import { configureSDK, loadMoreConversations, markRead } from "./im";
import { carryPersisted, earlierCursor, mergeMessages, messageKey, remintGuard } from "./history";
import { listAgents, uncontactedAgents, type DirectoryAgent } from "./agents";
import { buildOutgoingText } from "./mentions";
import { recipientDisabledKey, sendToEnabledRecipient } from "./send";
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
// This account's own display name, read from auth's user-info endpoint.
// "Portal user <uid>" is treated as absent (profile.ts); the rail card then
// uses the batch-resolved nickName, and a skeleton until that lands.
const profileName = ref("");
const profileAvatar = ref("");
const profileRoles = ref<string[]>([]);
const conversations = shallowRef<Conversation[]>([]);
const groups = ref<IMGroup[]>([]);
// UNI-IM-REDESIGN: every agent this user can DM (active definitions with an IM identity).
const directoryAgents = ref<DirectoryAgent[]>([]);
// Populated in startSession once the uid is known: the cache is per-account, so there is
// nothing meaningful to read before then.
const knownContacts = ref<Contact[]>([]);
// Boot restore runs before the login form renders, so the form never flashes for a user
// whose refresh cookie is still good.
const restoring = ref(!embedded && !isCallbackPath(window.location));
const dialOpen = ref(false);
const dialOpenId = ref("");
const activeChannel = ref<Channel>();
let pendingConversationTarget: ConversationTarget | null = null;

// UNI-T17: a deep link (e.g. from the library) to a DM the viewer is not in, or a
// group that is gone or that the viewer is not a member of, says so instead of
// leaving a blank pane. listGroups only returns the caller's groups; it is fetched
// fresh because syncGroups may not have landed yet. If that fetch fails, open
// anyway (history then reports its own error).
async function openPendingConversation(): Promise<void> {
  if (!pendingConversationTarget || !session.value || connection.value !== "connected") return;
  const targetSession = session.value;
  const target = resolveConversationTarget(pendingConversationTarget, String(targetSession.uid));
  pendingConversationTarget = null;
  if (!target) {
    loginError.value = t("chat.targetUnavailable");
    return;
  }
  if (target.channelType === ChannelTypeGroup) {
    const member = await listGroups(targetSession).then(
      (list) => list.some((group) => group.wukongChannelId === target.channelID),
      () => true,
    );
    if (session.value !== targetSession) return;
    if (!member) {
      loginError.value = t("chat.targetUnavailable");
      return;
    }
  }
  void openChannel(new Channel(target.channelID, target.channelType));
}
const activeGroupMembers = ref<GroupMember[]>([]);
const messages = shallowRef<Message[]>([]);
const liveResponses = ref<LiveAgentResponse[]>([]);
const streamConnection = ref<StreamConnectionState>("connected");
const draft = ref("");
const sending = ref(false);
const recipientDisabled = ref(false);
watch([activeChannel, draft], () => { recipientDisabled.value = false; });
const mentionedAgentUids = ref<string[]>([]);
const loadingHistory = ref(false);
const historyFinished = ref(false);
const loadingConversations = ref(false);
const hasMoreConversations = ref(true);
const chatElement = ref<HTMLElement>();
const groupDialogOpen = ref(false);
const dialogGroup = ref<IMGroup>();
const groupPreselect = ref<Contact[]>([]);
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
    return activeGroup.value?.title || t("chat.groupChat");
  }
  // "" = still resolving: the header renders a skeleton, never the UID.
  return personName(channel.channelID);
});

// Every UID the screen can show, resolved to a nickName in one batched call
// (auth directory/resolve). Known and in-flight UIDs are skipped, so this is
// a no-op on most recomputes. Resolution never provisions anyone.
const visibleUids = computed(() => {
  const uids = new Set<string>();
  if (session.value) uids.add(session.value.uid);
  for (const conversation of conversations.value) {
    if (conversation.channel.channelType === ChannelTypePerson) uids.add(conversation.channel.channelID);
    if (conversation.lastMessage?.fromUID) uids.add(conversation.lastMessage.fromUID);
  }
  for (const message of messages.value) if (message.fromUID) uids.add(message.fromUID);
  for (const member of activeGroupMembers.value) uids.add(String(member.uid));
  for (const response of liveResponses.value) uids.add(response.agentUid);
  for (const agent of directoryAgents.value) uids.add(String(agent.uid));
  if (activeChannel.value?.channelType === ChannelTypePerson) uids.add(activeChannel.value.channelID);
  return [...uids];
});
watch(visibleUids, (uids) => {
  if (session.value) void ensureNames(uids, session.value);
});
const dialOpenIdValid = computed(() => isDialableOpenId(dialOpenId.value));
const dialing = ref(false);
const dialError = ref("");
const sortedConversations = computed(() =>
  [...conversations.value].sort((left, right) => right.timestamp - left.timestamp),
);

/** UIDs of every agent this account has seen, so the rail can filter by them. */
const knownAgentUids = computed(
  () => new Set([
    ...knownContacts.value
      .filter((contact) => contact.accountType === "agent")
      .map((contact) => String(contact.id)),
    ...directoryAgents.value.map((agent) => String(agent.uid)),
  ]),
);

function isAgentUid(uid: string): boolean {
  return knownAgentUids.value.has(uid) || accountTypeOf(uid) === "agent";
}

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
        && isAgentUid(item.channel.channelID),
    );
  }
  return sortedConversations.value;
});

/** Groups with no conversation row yet (never opened, so WuKongIM has nothing to sync). */
const unopenedGroups = computed(() => railMode.value === "agents" ? [] : groups.value.filter(
  (item) => !conversations.value.some((c) => c.channel.channelID === item.wukongChannelId),
));

/** Agents tab: directory agents with no conversation yet, below the ones already talked to. */
const unopenedAgents = computed(() => railMode.value !== "agents" ? [] : uncontactedAgents(
  directoryAgents.value,
  conversations.value.filter((c) => c.channel.channelType === ChannelTypePerson).map((c) => c.channel.channelID),
));

/** A definition's description: the agent row's subtitle before there is a last message. */
function agentDescription(uid: string): string {
  return directoryAgents.value.find((agent) => String(agent.uid) === uid)?.description || "";
}

function agentRowName(agent: DirectoryAgent): string {
  return personName(String(agent.uid)) || agent.name;
}

function openAgent(agent: DirectoryAgent): void {
  void openChannel(new Channel(String(agent.uid), ChannelTypePerson));
}

// R1: on a phone the open chat covers the list, so a rail tap would filter a
// list nobody can see. Close the chat there; desktop shows both side by side.
function selectRail(mode: RailMode): void {
  railMode.value = mode;
  if (window.matchMedia("(max-width: 720px)").matches) activeChannel.value = undefined;
}

const totalUnread = computed(
  () => conversations.value.reduce((sum, item) => sum + (item.unread || 0), 0),
);

/** True only on a genuinely empty account, not on an empty filter result. */
const isFirstRun = computed(
  () => !sortedConversations.value.length && !groups.value.length,
);

// Board §03 anno 1: a DM header's sub-line is "@username · Enterprise" when known.
const directMeta = computed(() => {
  const channel = activeChannel.value;
  if (channel?.channelType !== ChannelTypePerson) return "";
  const contact = knownContacts.value.find((item) => String(item.id) === channel.channelID);
  const handle = handleFor(channel.channelID, contact?.username);
  const enterprise = !isAgentUid(channel.channelID) && isEnterprise(channel.channelID);
  return [handle && `@${handle}`, enterprise && t("badge.enterprise")].filter(Boolean).join(" · ");
});

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
  if (!last) return agentDescription(conversation.channel.channelID);
  const body = messageText(last);
  if (isOwnMessage(last)) return `${t("list.you")} ${body}`;
  // Group previews name the speaker; a direct chat's speaker is already the row.
  // Until the speaker resolves the preview is just the body, never their UID.
  if (conversation.channel.channelType === ChannelTypeGroup) {
    const who = personName(last.fromUID);
    if (who) return `${who}: ${body}`;
  }
  return body;
}

/** True while a person row's nickName is still resolving (renders a skeleton). */
function isResolving(conversation: Conversation): boolean {
  return conversation.channel.channelType === ChannelTypePerson && !conversationTitle(conversation);
}

function isAgentConversation(conversation: Conversation): boolean {
  return conversation.channel.channelType === ChannelTypePerson
    && isAgentUid(conversation.channel.channelID);
}

function conversationKind(conversation: Conversation): "person" | "agent" | "group" {
  if (conversation.channel.channelType === ChannelTypeGroup) return "group";
  return isAgentConversation(conversation) ? "agent" : "person";
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
      || t("chat.groupChat");
  }
  return personName(channel.channelID);
}

/**
 * The one naming rule (UNI-IMUX2): the resolved nickName, else a real name we
 * already hold. "" means still resolving and renders as a skeleton; a UID is
 * never shown in its place. A uid with no account at all says exactly that.
 */
function personName(uid: string): string {
  if (isMissing(uid)) return t("profile.noAccount");
  const member = activeGroupMembers.value.find((item) => String(item.uid) === uid);
  return nameFor(uid, member?.displayName, contactName(uid), member?.username);
}

function agentName(uid: string): string {
  return personName(uid) || t("badge.agent");
}

/**
 * The message sender's avatar: resolved, else the group member row's; "" = initials (UNI-IM-AVATARS).
 * A failed image is shared with the conversation rows (names.ts avatarFailed, IM1).
 */
function messageAvatar(message: Message): string {
  const member = activeGroupMembers.value.find((item) => String(item.uid) === message.fromUID);
  return avatarSrc(message.fromUID, member?.avatar);
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

// W5 (spec §2.4): a WuKong reset forgets registered connect tokens, so the WS gets
// auth-fail. Re-mint once (the mint re-registers the token) and reconnect; a second
// failure before any success stays on authFailed instead of looping.
const remint = remintGuard();

const connectStatusListener: ConnectStatusListener = (status, reasonCode) => {
  if (status === ConnectStatus.Connected) {
    connection.value = "connected";
    remint.reset();
    void Promise.all([syncConversations(), syncGroups(), refreshActiveHistory()]);
    void openPendingConversation();
  } else if (status === ConnectStatus.Connecting) {
    connection.value = "connecting";
  } else if (status === ConnectStatus.ConnectFail && reasonCode === 2) {
    connection.value = "authFailed";
    if (remint.take()) void remintConnectToken();
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
    // R6: the server counted it unread; the user is looking at it.
    if (!isOwnMessage(message)) markChannelRead(message.channel);
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
    const changed = carryPersisted(existing, Object.assign(new Message(), existing));
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
  const cached = loadCachedProfile(nextSession.uid);
  profileName.value = cached?.displayName || "";
  profileAvatar.value = cached?.avatar || "";
  profileRoles.value = cached?.roles ?? [];
  void loadProfile(nextSession);
  // Names cached by this account on this browser, so a reload renders them instead of
  // raw UIDs. Reading it here (not at module scope) keeps one account's names out of
  // another's session when the shell swaps users without a sign-out.
  knownContacts.value = loadCachedContacts(nextSession.uid);
  void listAgents(nextSession).then((agents) => {
    if (session.value?.uid === nextSession.uid) directoryAgents.value = agents;
  });
  const sdk = configureSDK(nextSession);
  installListeners();
  connection.value = "connecting";
  sdk.connect();
}

// A failed profile read is not worth surfacing: the identity card falls back to
// the resolved nickName, and blocking or alarming the user over a display name
// they did not ask for would be worse than the missing name.
async function loadProfile(forSession: ConnectSession): Promise<void> {
  const profile = await fetchProfile(forSession);
  if (!profile || session.value?.uid !== forSession.uid) return;
  profileName.value = profile.displayName;
  profileAvatar.value = profile.avatar;
  profileRoles.value = profile.roles ?? [];
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
let shellAuthGeneration = 0;
const shellBridge = installShellBridge({
  onConversation(target) {
    pendingConversationTarget = target;
    void openPendingConversation();
  },
  onAuth(intent) {
    shellAuthGeneration += 1;
    if (!intent.token) {
      pendingConversationTarget = null;
      loggingIn.value = false;
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
  const generation = shellAuthGeneration;
  if (session.value?.jwt === accessToken) return;
  // Same user (the routine renewal): swap the login token, keep the socket and its IM token.
  // If WuKongIM ever rejects that token, remintConnectToken mints from this fresh session.jwt.
  if (session.value && renewsSameUser(session.value, accessToken)) {
    session.value = { ...session.value, jwt: accessToken };
    return;
  }
  pendingConversationTarget = null;
  if (session.value) teardownSession();
  loginError.value = "";
  loggingIn.value = true;
  try {
    const nextSession = await imSession({ accessToken });
    if (generation !== shellAuthGeneration) return;
    startSession(nextSession);
  } catch (error) {
    if (generation !== shellAuthGeneration) return;
    pendingConversationTarget = null;
    loginError.value = error instanceof Error ? error.message : t("login.errFailed");
    shellBridge.reportAuthRequired("rejected");
  } finally {
    if (generation === shellAuthGeneration) loggingIn.value = false;
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
    hasMoreConversations.value = true;
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t("chat.errConversations");
  }
}

// Q3: the list is cursor-paged (50 per page). Scrolling near the bottom loads the next page.
async function loadMoreConversationPage(): Promise<void> {
  const pageSession = session.value;
  if (!pageSession || loadingConversations.value || !hasMoreConversations.value) return;
  loadingConversations.value = true;
  try {
    const page = await loadMoreConversations(pageSession);
    if (session.value !== pageSession) return;
    hasMoreConversations.value = page.length > 0;
    const known = new Set(conversations.value.map((item) => channelKey(item.channel)));
    const fresh = page.filter((item) => !known.has(channelKey(item.channel)));
    conversations.value = [...conversations.value, ...fresh];
    const sdk = WKSDK.shared().conversationManager;
    sdk.conversations = [...sdk.conversations, ...fresh];
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t("chat.errConversations");
  } finally {
    loadingConversations.value = false;
  }
}

function conversationListScrolled(event: Event): void {
  const list = event.target as HTMLElement;
  if (list.scrollHeight - list.scrollTop - list.clientHeight < 120) void loadMoreConversationPage();
}

// R6: opening a channel, or a message arriving while it is open, clears its unread on the
// server and locally. A failed call is harmless: the badge comes back on the next sync.
function markChannelRead(channel: Channel): void {
  const readSession = session.value;
  if (!readSession) return;
  const local = conversations.value.find((item) => item.channel.isEqual(channel));
  if (local?.unread) {
    local.unread = 0;
    conversations.value = [...conversations.value];
  }
  void markRead(channel, readSession).catch(() => undefined);
}

async function remintConnectToken(): Promise<void> {
  const current = session.value;
  if (!current) return;
  try {
    const next = await imSession({ accessToken: current.jwt });
    if (session.value !== current) return;
    session.value = next;
    WKSDK.shared().disconnect(); // close the refused socket before the SDK opens a new one
    const sdk = configureSDK(next);
    connection.value = "connecting";
    sdk.connect();
  } catch {
    // The access token itself is stale: leave authFailed; the shell/refresh path recovers it.
  }
}

// R5: messages sent while the WS was down never reach this tab live. On (re)connect, pull the
// open channel's latest page again and merge it; an initial connect with no chat open is a no-op.
async function refreshActiveHistory(): Promise<void> {
  const channel = activeChannel.value;
  if (!channel || loadingHistory.value) return;
  const generation = viewGeneration;
  try {
    const latest = await WKSDK.shared().chatManager.syncMessages(channel, {
      limit: 30, startMessageSeq: 0, endMessageSeq: 0, pullMode: PullMode.Up,
    });
    if (generation !== viewGeneration) return;
    messages.value = mergeMessages(messages.value, latest);
    reconcileResponses();
    scrollToBottom();
  } catch {
    // The next reconnect or a reopen retries; the open view keeps what it has.
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

/** The bar's 重连: the SDK retries by itself; this asks now instead of on its backoff. */
function reconnectIm(): void {
  if (!session.value) return;
  connection.value = "connecting";
  WKSDK.shared().connect();
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
  markChannelRead(channel);
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

// UNI-OID D3: the dial box takes an Open ID. auth resolves it to this env's uid
// (provisioning on first contact) in a POST body; the channel stays uid-keyed.
async function dialOpenIdSubmit(): Promise<void> {
  const dialSession = session.value;
  if (!dialOpenIdValid.value || !dialSession || dialing.value) return;
  dialing.value = true;
  dialError.value = "";
  try {
    const uid = await provisionAddress({ openId: dialOpenId.value.trim() }, dialSession);
    if (session.value !== dialSession) return;
    dialOpenId.value = "";
    dialOpen.value = false;
    void openChannel(new Channel(String(uid), ChannelTypePerson));
  } catch {
    if (session.value === dialSession) dialError.value = t("uid.notFound");
  } finally {
    dialing.value = false;
  }
}

function openGroup(group: IMGroup): void {
  void openChannel(new Channel(group.wukongChannelId, ChannelTypeGroup));
}

async function loadEarlier(): Promise<void> {
  const channel = activeChannel.value;
  // R4: live messages carry WuKong seqs; only history rows hold im's cursor.
  const cursor = earlierCursor(messages.value);
  if (!channel || cursor === undefined || loadingHistory.value || historyFinished.value) return;
  if (cursor === 0) {
    historyFinished.value = true; // the oldest row is id 1: nothing is older
    return;
  }

  const generation = viewGeneration;
  loadingHistory.value = true;
  try {
    const history = await WKSDK.shared().chatManager.syncMessages(channel, {
      limit: 30,
      startMessageSeq: cursor,
      endMessageSeq: 0,
      pullMode: PullMode.Down,
    });
    if (generation !== viewGeneration) return;
    messages.value = mergeMessages(history, messages.value);
    reconcileResponses();
    historyFinished.value = history.length < 30 || cursor <= 1;
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
  const sendSession = session.value;
  if (!text || !channel || !sendSession || sending.value || connection.value !== "connected") return;

  const generation = viewGeneration;
  const originalDraft = draft.value;
  const mentionUids = mentionedAgentUids.value;
  const current = () => generation === viewGeneration && session.value === sendSession
    && connection.value === "connected" && draft.value === originalDraft
    && mentionedAgentUids.value === mentionUids;
  sending.value = true;
  recipientDisabled.value = false;
  try {
    const outcome = await sendToEnabledRecipient(channel, sendSession, current, async () => {
      const content = buildOutgoingText(text, channel.channelType, mentionUids);
      const message = await WKSDK.shared().chatManager.send(content, channel);
      if (!current()) return;
      draft.value = "";
      mentionedAgentUids.value = [];
      messages.value = mergeMessages(messages.value, [message]);
      scrollToBottom();
    }, mentionUids);
    if (current()) recipientDisabled.value = outcome === "disabled";
    if (outcome === "unavailable") console.warn("im_recipient_check_unavailable");
  } catch (error) {
    if (current()) loginError.value = error instanceof Error ? error.message : t("composer.errSend");
  } finally {
    sending.value = false;
  }
}

function showCreateGroup(preselect: Contact[] = []): void {
  dialogGroup.value = undefined;
  groupPreselect.value = preselect;
  groupDialogOpen.value = true;
}

// Someone else's profile card (UNI-IMUX3): the shell's account-ui module, the
// same one the rail "Me" slot opens. Five entry points call this: chat header,
// message sender, group member, picker ⓘ, direct-chat row avatar
// (UNI-AVATAR-CARD-R2). Actions follow the context (board
// §03): no "Message" inside that very DM; the picker's primary is "Select".
const accountUi = useAccountPopover();
function openProfile(anchor: HTMLElement, target: ProfileTarget): void {
  if (!session.value || !(target.uid || target.openId || target.portalUid)) return;
  const uid = target.uid;
  // UNI-OID: IM rows know a uid; pass the Open ID too when resolve already named it (D2: none for agents).
  const openId = target.openId || (uid ? openIdOf(uid) || undefined : undefined);
  const channel = activeChannel.value;
  const can = profileActions(target, {
    selfUid: session.value.uid,
    dmUid: channel?.channelType === ChannelTypePerson ? channel.channelID : undefined,
  });
  const contact = (): Contact => ({
    id: Number(uid), username: target.known?.username ?? "",
    displayName: personName(uid) || target.known?.nickName || "", accountType: target.known?.accountType ?? "human",
  });
  // "Send message": a uid opens the DM; an openId alone is resolved (and provisioned once) first.
  const message = async (): Promise<void> => {
    const messageSession = session.value;
    if (uid || !openId || !messageSession) return openContact(contact());
    try {
      const id = await provisionAddress({ openId }, messageSession);
      if (session.value === messageSession) openContact({ ...contact(), id });
    } catch (error) {
      if (session.value === messageSession) loginError.value = error instanceof Error ? error.message : t("uid.notFound");
    }
  };
  void accountUi.openProfile(anchor, profileParams(session.value, getLocale(), {
    openId, uid, portalUid: openId ? undefined : target.portalUid, known: target.known,
    onSelect: can.select ? target.select : undefined,
    onMessage: can.message ? () => void message() : undefined,
    onAddToGroup: !can.addToGroup ? undefined : () => {
      groupDialogOpen.value = false;
      void nextTick(() => showCreateGroup([contact()]));
    },
  }));
}

function senderProfile(message: Message, event: MouseEvent): void {
  if (isOwnMessage(message)) return;
  const member = activeGroupMembers.value.find((item) => String(item.uid) === message.fromUID);
  openProfile(event.currentTarget as HTMLElement, {
    uid: message.fromUID,
    known: { nickName: personName(message.fromUID), username: member?.username, avatar: member?.avatar,
      accountType: isAgentMessage(message) ? "agent" : member?.accountType },
  });
}

/** A direct chat's peer: the chat header title and the conversation-row avatar. */
function personProfile(uid: string, anchor: HTMLElement): void {
  const contact = knownContacts.value.find((item) => String(item.id) === uid);
  openProfile(anchor, {
    uid,
    known: { nickName: personName(uid), username: contact?.username,
      accountType: isAgentUid(uid) ? "agent" : contact?.accountType },
  });
}

function headerProfile(event: MouseEvent): void {
  const channel = activeChannel.value;
  if (channel?.channelType !== ChannelTypePerson) return;
  personProfile(channel.channelID, event.currentTarget as HTMLElement);
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
  directoryAgents.value = [];
  knownContacts.value = [];
  resetNames();
  profileName.value = "";
  profileAvatar.value = "";
  profileRoles.value = [];
  dialOpen.value = false;
  dialOpenId.value = "";
  dialError.value = "";
  activeChannel.value = undefined;
  activeGroupMembers.value = [];
  messages.value = [];
  liveResponses.value = [];
  password.value = "";
  connection.value = "disconnected";
  loginError.value = "";
}

// The AccountPopover's two exits (UNI-ACCTUI). Embedded, both go to the shell:
// the refresh cookie lives on its origin, and its session bump pushes a
// null-token auth intent that tears this child down through onAuth.
// Standalone, both land on the shell's /account, which owns sign-out there.
function openAccount(): void {
  if (embedded) {
    shellBridge.requestAccount();
    return;
  }
  window.location.assign(shellAccountUrl());
}

function signOut(): void {
  if (embedded) {
    shellBridge.requestLogout();
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
        @click="selectRail('all')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
        <span class="rail-label">{{ t("tab.chats") }}</span>
        <span v-if="totalUnread" class="rail-dot" />
      </button>
      <button
        class="rail-btn"
        :class="{ active: railMode === 'groups' }"
        type="button"
        :title="t('list.groups')"
        :aria-label="t('list.groups')"
        :aria-pressed="railMode === 'groups'"
        @click="selectRail('groups')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
        <span class="rail-label">{{ t("tab.groups") }}</span>
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
        @click="selectRail('agents')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" /><path d="M12 22V12" /><path d="M4 7l8 5 8-5" /></svg>
        <span class="rail-label">{{ t("tab.agents") }}</span>
      </button>
      <button
        class="rail-btn"
        type="button"
        :title="t('list.searchPlaceholder')"
        :aria-label="t('list.searchPlaceholder')"
        @click="focusSearch"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <span class="rail-label">{{ t("tab.search") }}</span>
      </button>

      <span class="rail-spacer" />
      <IdentityCard
        v-if="session"
        :uid="session.uid"
        :display-name="profileName || nameFor(session.uid)"
        :avatar="profileAvatar"
        :roles="profileRoles"
        :token="session.jwt"
        @account="openAccount"
        @logout="signOut"
      />
    </nav>

    <aside class="sidebar">
      <header class="sidebar-header">
        <div>
          <strong>{{ railMode === "all" ? t("list.all") : railMode === "groups" ? t("list.groups") : t("list.agents") }}</strong>
          <span :class="{ online: connection === 'connected' }">{{ t(`conn.${connection}`) }}</span>
        </div>
        <!-- Phones (board §05): healthy = an 8px dot by the title; trouble gets the bar below. -->
        <i
          class="conn-dot"
          :class="{ online: connection === 'connected' }"
          role="img"
          :aria-label="t(`conn.${connection}`)"
          data-testid="im-conn-dot"
        />
        <button
          class="icon-button"
          type="button"
          :title="t('group.create')"
          :aria-label="t('group.create')"
          @click="showCreateGroup()"
        >
          +
        </button>
      </header>

      <p
        v-if="connection !== 'connected'"
        class="connbar"
        :class="connection === 'connecting' ? 'warn' : 'err'"
        role="status"
        data-testid="im-connbar"
      >
        <span>{{ connection === "connecting" ? t("system.reconnecting") : t(`conn.${connection}`) }}</span>
        <button v-if="connection === 'disconnected'" type="button" @click="reconnectIm">{{ t("system.reconnect") }}</button>
      </p>

      <div class="sidebar-tools">
        <ContactPicker
          :session="session"
          :placeholder="t('list.searchPlaceholder')"
          :agents="directoryAgents"
          @agent="openAgent"
          @select="openContact"
          @profile="openProfile"
        />
        <form v-if="dialOpen" class="uid-dial" @submit.prevent="dialOpenIdSubmit">
          <input
            v-model="dialOpenId"
            class="contact-search"
            inputmode="text"
            maxlength="190"
            :aria-label="t('empty.pathUid')"
            :aria-invalid="!!dialError"
            :placeholder="t('uid.dialPlaceholder')"
            autocomplete="off"
            spellcheck="false"
            @input="dialError = ''"
          >
          <button class="primary" type="submit" :disabled="!dialOpenIdValid || dialing">
            {{ t("uid.open") }}
          </button>
          <p v-if="dialError" class="error" role="alert" data-testid="im-dial-error">{{ dialError }}</p>
        </form>
        <button v-else class="quiet dial-uid" type="button" @click="openDial">
          {{ t("empty.pathUid") }}
        </button>
      </div>

      <nav class="conversation-list" :aria-label="t('list.all')" @scroll.passive="conversationListScrolled">
        <div
          v-for="conversation in visibleConversations"
          :key="channelKey(conversation.channel)"
          class="conversation-row"
        >
        <!-- Direct chat: the avatar is its own control, a sibling over the
             avatar column (no button-in-button), opening that person's card;
             the row still opens the chat (UNI-AVATAR-CARD-R2). Groups: none. -->
        <button
          v-if="conversation.channel.channelType === ChannelTypePerson && !isResolving(conversation)"
          class="avatar-trigger"
          type="button"
          data-testid="im-row-avatar-profile"
          :aria-label="t('profile.view', { name: conversationTitle(conversation) })"
          @click="personProfile(conversation.channel.channelID, $event.currentTarget as HTMLElement)"
        />
        <button
          class="conversation"
          :class="{ active: activeChannel?.isEqual(conversation.channel) }"
          type="button"
          @click="openChannel(conversation.channel)"
        >
          <RowAvatar
            :id="conversation.channel.channelID"
            :name="conversationTitle(conversation)"
            :kind="conversationKind(conversation)"
            :unnamed="isResolving(conversation)"
          />
          <span class="conversation-copy">
            <span class="conversation-name">
              <!-- nickName is mandatory: while it resolves, a skeleton — never the UID. -->
              <strong v-if="isResolving(conversation)" class="name-skeleton" data-testid="im-name-skeleton" :aria-label="t('chat.loading')" />
              <strong v-else>{{ conversationTitle(conversation) }}</strong>
              <span v-if="isAgentConversation(conversation)" class="tag agent">
                {{ t("badge.agent") }}
              </span>
            </span>
            <small>{{ conversationSubtitle(conversation) || t("empty.noMessages") }}</small>
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
        </div>

        <!-- Groups this account belongs to but has no conversation row for yet
             (never opened, so WuKongIM has nothing to sync). -->
        <button
          v-for="group in unopenedGroups"
          :key="group.id"
          class="conversation"
          :class="{ active: activeChannel?.channelID === group.wukongChannelId }"
          type="button"
          @click="openGroup(group)"
        >
          <RowAvatar :id="group.wukongChannelId" :name="group.title" kind="group" />
          <span class="conversation-copy">
            <span class="conversation-name"><strong>{{ group.title }}</strong></span>
            <small>{{ t("empty.noMessages") }}</small>
          </span>
        </button>

        <!-- Agents tab (UNI-IM-REDESIGN): every agent this user can DM, even
             before the first message. Tapping opens a normal direct chat. -->
        <div v-for="agent in unopenedAgents" :key="agent.uid" class="conversation-row" data-testid="im-agent-row">
          <button
            class="avatar-trigger"
            type="button"
            :aria-label="t('profile.view', { name: agentRowName(agent) })"
            @click="personProfile(String(agent.uid), $event.currentTarget as HTMLElement)"
          />
          <button
            class="conversation"
            :class="{ active: activeChannel?.channelID === String(agent.uid) }"
            type="button"
            @click="openAgent(agent)"
          >
            <RowAvatar :id="String(agent.uid)" :name="agentRowName(agent)" kind="agent" />
            <span class="conversation-copy">
              <span class="conversation-name">
                <strong>{{ agentRowName(agent) }}</strong>
                <span class="tag agent">{{ t("badge.agent") }}</span>
              </span>
              <small>{{ agent.description || t("empty.noMessages") }}</small>
            </span>
          </button>
        </div>

        <p
          v-if="!isFirstRun && !visibleConversations.length && !unopenedGroups.length && !unopenedAgents.length"
          class="empty-list"
          data-testid="im-empty-tab"
        >
          {{ t(railMode === "groups" ? "empty.noGroups" : railMode === "agents" ? "empty.noAgents" : "empty.noConversations") }}
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
          <!-- A direct chat's title is the profile trigger (board §03 anno 1). -->
          <h2 v-if="activeTitle && activeChannel?.channelType === ChannelTypePerson">
            <button
              class="title-trigger"
              type="button"
              data-testid="im-header-profile"
              :aria-label="t('profile.view', { name: activeTitle })"
              @click="headerProfile"
            >{{ activeTitle }}</button>
          </h2>
          <h2 v-else-if="activeTitle">{{ activeTitle }}</h2>
          <h2 v-else class="name-skeleton wide" :aria-label="t('chat.loading')" />
          <span v-if="activeChannel">
            {{ activeChannel.channelType === ChannelTypeGroup
              ? activeGroupMeta
              : directMeta || t("chat.directMessage") }}
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
        @group="showCreateGroup()"
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
            <!-- Message avatar (UNI-IM-AVATARS): resolve data's avatar image,
                 else the same initial-letter placeholder every other avatar uses. -->
            <span class="avatar message-avatar" data-testid="im-message-avatar">
              <img v-if="messageAvatar(message)" :src="messageAvatar(message)" alt="" referrerpolicy="no-referrer" @error="avatarFailed(message.fromUID, messageAvatar(message))">
              <template v-else>{{ (isOwnMessage(message) ? t("chat.you") : personName(message.fromUID))[0]?.toUpperCase() }}</template>
            </span>
            <span class="message-copy">
              <span class="sender">
                <template v-if="isOwnMessage(message)">{{ t("chat.you") }}</template>
                <button
                  v-else-if="personName(message.fromUID)"
                  class="sender-trigger"
                  type="button"
                  data-testid="im-sender-profile"
                  :aria-label="t('profile.view', { name: personName(message.fromUID) })"
                  @click="senderProfile(message, $event)"
                >{{ personName(message.fromUID) }}</button>
                <span v-else class="name-skeleton" :aria-label="t('chat.loading')" />
                <span v-if="isAgentMessage(message)" class="tag agent">{{ t("badge.agent") }}</span>
                <span v-if="relayLabel(message)" class="tag relay">{{ relayLabel(message) }}</span>
              </span>
              <div class="bubble">{{ messageText(message) }}</div>
              <time>{{ messageTime(message) }}</time>
            </span>
          </article>

          <template v-for="response in liveResponses" :key="response.sourceKey">
            <!-- Belongs to this conversation, so it sits in the timeline rather
                 than as a corner toast that covers the composer. -->
            <SystemLine v-if="response.status === 'error'">
              {{ rejectionCopy(response.code || "", getLocale()) }}
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
              :readonly="sending"
              :aria-label="t('composer.label')"
              :placeholder="activeAgents.length ? t('composer.placeholderAgents') : t('composer.placeholder')"
              rows="2"
              @keydown.enter.exact.prevent="sendMessage"
            />
          </div>
          <button
            class="primary send"
            type="submit"
            :disabled="sending || !draft.trim() || connection !== 'connected'"
          >
            {{ t("composer.send") }}
          </button>
          <p v-if="recipientDisabled" class="composer-hint" role="status" data-testid="recipient-disabled">
            {{ t(recipientDisabledKey(!!activeChannel && (activeChannel.channelType !== 1 || isAgentUid(activeChannel.channelID)))) }}
          </p>
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
      :directory-agents="directoryAgents"
      :preselect="groupPreselect"
      @close="groupDialogOpen = false"
      @profile="openProfile"
      @created="groupCreated"
      @changed="groupChanged"
      @removed="groupRemoved"
    />
    <!-- Only genuinely global failures stay a toast; conversation-scoped ones
         became system lines above. -->
    <p v-if="loginError" class="toast" role="alert" @click="loginError = ''">{{ loginError }}</p>
  </main>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Settings2, Info } from "@lucide/vue";
import AgentManagement from "./agent-definition/AgentManagement.vue";
import AgentManagementOverlay from "./agent-definition/AgentManagementOverlay.vue";
import AgentEffective from "./agent-definition/AgentEffective.vue";
import { createEffectiveApi } from "./agent-definition/effective";
import { createDefinitionApi } from "./agent-definition/api";
import { sessionTransport } from "./agent-definition/transport";
import { text as definitionText } from "./agent-definition/messages";
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
  type DirectoryEntry,
  provisionContact,
  createSession,
  getGroupMembers,
  imBase,
  coreBase,
  imSession,
  listGroups,
  provisionAddress,
  recipientEnabled,
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
import { installShellBridge, isInShell, nextShellCredential, shellAccountUrl } from "./shell";
import { installEmbedHost, revokeServerSession } from "./embedHost";
import { resolveConversationTarget, type ConversationTarget } from "./conversationTarget";
import {
  clearCachedProfile,
  fetchProfile,
  loadCachedProfile,
  saveCachedProfile,
} from "./profile";
import { accountTypeOf, avatarFailed, avatarSrc, ensureNames, handleFor, isEnterprise, isMissing, nameFor, openIdOf, resetNames, setAgentProjection } from "./names";
import SearchPanel from "./components/SearchPanel.vue";
import GroupDialog from "./components/GroupDialog.vue";
import RowAvatar from "./components/RowAvatar.vue";
import IdentityCard from "./components/IdentityCard.vue";
import { profileActions, profileParams, useAccountPopover, type ProfileTarget } from "./accountPopover";
import { getLocale } from "./i18n";
import EmptyPaths from "./components/EmptyPaths.vue";
import SystemLine from "./components/SystemLine.vue";
import { cancelSDKSync, configureSDK, loadMoreConversations, markRead, reconcileAckedConversation, sendAcked } from "./im";
import { channelKey, useConversationBatch } from "./hiding";
import {
  carryPersisted, CONFLICT_WINDOW_MS, connectionConflict, earlierCursor, isPeerReport, mergeMessages, messageKey,
  PEER_FRESH_MS, PEER_HEARTBEAT_MS, PEER_QUERY_WAIT_MS, peerLiveness, PROBE_DELAYS_MS, PROBE_JITTER, remintGuard,
} from "./history";
import { AgentDirectory, uncontactedAgents, type DirectoryAgent } from "./agents";
import { buildOutgoingText, mentionCandidates, mentionsMe } from "./mentions";
import { throttle, unknownGroup } from "./groupSync";
import { isAgentUnavailableNotice, isExecutionFailedNotice, recipientDisabledKey, sendToEnabledRecipient } from "./send";
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
// Framed by an agentia host instead (embedHost.ts): decided only by an origin-checked
// embed-init, never by a URL flag. That host hands over a portal credential once; im-web
// then owns its session like standalone (refresh cookie on its own, same-site origin).
const agentiaHosted = ref(false);
const shellOwnsSession = () => embedded && !agentiaHosted.value;
const { t } = useI18n();
const username = ref("");
const password = ref("");
const loginError = ref("");
const loggingIn = ref(false);
const session = ref<ConnectSession>();
watch(session, cancelSDKSync, { flush: "sync" });
const managementOpen = ref(false);
const canManageAgents = ref(false);
const agentDefinitions = createDefinitionApi(sessionTransport(coreBase, () => session.value));
const agentEffective = createEffectiveApi(sessionTransport(coreBase, () => session.value));
const effectiveOpen = ref(false);
const agentDirectory = new AgentDirectory();
let directoryTimer: ReturnType<typeof setTimeout> | undefined;
let directoryReading: ConnectSession | undefined;
let directoryEpoch = 0;
const directoryError = ref(false);
async function readAgentCapabilities() {
  const current = session.value;
  if (!current) return;
  try {
    const catalog = await agentDefinitions.catalog();
    if (session.value === current) canManageAgents.value = catalog.capabilities.read === true;
  } catch { if (session.value === current) canManageAgents.value = false; }
}
async function refreshAgentPresentation(poll = false) {
  const current = session.value;
  if (!current || directoryReading === current) return;
  directoryReading = current;
  try {
    if (poll && !await agentDirectory.poll(current)) return;
    if (!poll) await agentDirectory.refresh(current);
    if (session.value !== current) return;
    directoryAgents.value = agentDirectory.agents;
    directoryError.value = false;
    await ensureNames(visibleUids.value, current, true);
    if (session.value !== current) return;
    setAgentProjection(directoryAgents.value);
    if (activeGroup.value) await loadActiveGroupMembers(activeGroup.value, viewGeneration);
  } catch {
    if (session.value === current) { directoryAgents.value = []; setAgentProjection([]); directoryError.value = true; }
  } finally { if (directoryReading === current) directoryReading = undefined; }
}
async function pollAgentDirectory(epoch = directoryEpoch) {
  if (document.visibilityState === "visible") await refreshAgentPresentation(true);
  if (session.value && epoch === directoryEpoch) directoryTimer = setTimeout(() => pollAgentDirectory(epoch), 2000);
}
function rereadAgentDirectory() {
  if (document.visibilityState !== "hidden" && session.value) {
    void refreshAgentPresentation(); void readAgentCapabilities();
  }
}
// Connection state is a key, not a sentence. It used to hold the English label
// itself, which both drove `sendMessage`'s guard and rendered in the header —
// translating it in place would have silently broken the guard.
type ConnectionState = "connected" | "connecting" | "disconnected" | "authFailed" | "conflict";
const connection = ref<ConnectionState>("disconnected");
// Which rail slot is selected. Purely a list filter; it never touches the SDK.
type RailMode = "all" | "groups" | "agents";
const railMode = ref<RailMode>("all");
// IM3-D5: the search page (SearchPanel) replaces the list while open.
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
const activeAgentUid = computed(() => activeChannel.value?.channelType === ChannelTypePerson
  ? directoryAgents.value.find(agent => String(agent.uid) === activeChannel.value?.channelID)?.uid : undefined);
watch([activeChannel, session], () => { effectiveOpen.value = false; });
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
// AGENT-REPLY-1: a DM with a stopped/deleted agent keeps its history readable but
// greys the composer. Best effort: a failed check leaves it open (the send gate and
// the server notice still apply).
const peerUnavailable = ref(false);
watch([activeChannel, session], async ([channel, current]) => {
  peerUnavailable.value = false;
  if (!channel || !current || channel.channelType !== ChannelTypePerson || !isAgentUid(channel.channelID)) return;
  const enabled = await recipientEnabled(channel.channelID, current).catch(() => true);
  if (activeChannel.value === channel && session.value === current) peerUnavailable.value = !enabled;
});
const mentionedAgentUids = ref<string[]>([]);
// IM-FIX-1: @-mentioned people, kept apart from agents (no task, no recipient-enabled gate).
const mentionedPersonUids = ref<string[]>([]);
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

// IM3-D4 (Q3 §2): hide / unhide / mark read, one row or many; state lives on the server.
const batch = useConversationBatch({
  session: () => session.value,
  conversations,
  t,
  // The SDK keeps its own copy of the list; a hidden row must not come back from it.
  onHidden: (keys) => {
    const sdk = WKSDK.shared().conversationManager;
    const gone = new Set(keys);
    sdk.conversations = sdk.conversations.filter((item) => !gone.has(channelKey(item.channel)));
  },
});
const hiddenOpen = ref(false);
const listMenuOpen = ref(false);
type RowMenu = { conversation: Conversation; x: number; y: number; header: boolean };
const menu = ref<RowMenu>();
const longPressMs = 500;
let pressTimer: ReturnType<typeof setTimeout> | undefined;
let longPressed = false;

/** Row ⋯, right-click, long-press or the chat header: one menu at the pointer (or under the button). */
function openRowMenu(conversation: Conversation, event: { clientX: number; clientY: number; currentTarget?: EventTarget | null }, header = false): void {
  let { clientX: x, clientY: y } = event;
  const anchor = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : undefined;
  if (anchor && !x && !y) { x = anchor.left; y = anchor.bottom; } // keyboard activation
  menu.value = { conversation, x: Math.max(8, Math.min(x, window.innerWidth - 200)), y: Math.max(8, Math.min(y, window.innerHeight - 160)), header };
  void nextTick(() => document.querySelector<HTMLElement>(".row-menu button")?.focus());
}

function openChatMenu(event: MouseEvent): void {
  const channel = activeChannel.value;
  if (!channel) return;
  const conversation = conversations.value.find((item) => item.channel.isEqual(channel))
    || batch.hidden.value.find((item) => item.channel.isEqual(channel))
    || Object.assign(new Conversation(), { channel });
  openRowMenu(conversation, event, true);
}

/** Phones: a 500 ms press opens the row menu; the click that ends it does not open the chat. */
function pressStart(conversation: Conversation, event: PointerEvent): void {
  if (event.pointerType !== "touch" || batch.selecting.value) return;
  clearTimeout(pressTimer);
  const { clientX, clientY } = event;
  pressTimer = setTimeout(() => {
    longPressed = true;
    openRowMenu(conversation, { clientX, clientY });
  }, longPressMs);
}

function pressEnd(): void {
  clearTimeout(pressTimer);
}

function rowClicked(conversation: Conversation): void {
  if (longPressed) {
    longPressed = false;
    return;
  }
  if (batch.selecting.value) {
    batch.toggle(channelKey(conversation.channel));
    return;
  }
  void openChannel(conversation.channel);
}

async function menuAction(action: "hide" | "unhide" | "read" | "select"): Promise<void> {
  const target = menu.value;
  menu.value = undefined;
  if (!target) return;
  const key = channelKey(target.conversation.channel);
  if (action === "select") {
    hiddenOpen.value = false;
    batch.startSelecting(key);
    return;
  }
  const outcome = await batch.run(action, [key]);
  if (action === "hide" && outcome.ok.length && activeChannel.value?.isEqual(target.conversation.channel)) {
    activeChannel.value = undefined;
  }
}

function startSelecting(): void {
  listMenuOpen.value = false;
  hiddenOpen.value = false;
  batch.startSelecting();
}

function openHiddenView(): void {
  listMenuOpen.value = false;
  batch.stopSelecting();
  hiddenOpen.value = true;
  void batch.refreshHidden();
}

/** Esc: an open menu first, then select mode. */
function onKeydown(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
  // IM3-D5: Ctrl/⌘+K anywhere, "/" when not typing, open the search page.
  if (((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") || (event.key === "/" && !typing && !event.ctrlKey && !event.metaKey && !event.altKey)) {
    if (!session.value) return;
    event.preventDefault();
    focusSearch();
    return;
  }
  if (event.key !== "Escape") return;
  if (menu.value || listMenuOpen.value) {
    menu.value = undefined;
    listMenuOpen.value = false;
  } else if (batch.selecting.value) {
    batch.stopSelecting();
  }
}

/** H7: another device may have hidden or un-hidden rows while this tab was in the background. */
function onVisible(): void {
  if (document.visibilityState === "visible" && session.value && connection.value === "connected") {
    void syncConversations();
    void batch.refreshHidden();
    void refreshAgentPresentation();
    void readAgentCapabilities();
  }
}
document.addEventListener("keydown", onKeydown);
document.addEventListener("visibilitychange", onVisible);
window.addEventListener("focus", rereadAgentDirectory);
window.addEventListener("online", rereadAgentDirectory);
window.addEventListener("online", remintWhenOnline);
// A closing tab releases the connection at once, so a yielded tab can take it over.
const releaseOnHide = () => { if (holding) announce("released"); holding = false; };
window.addEventListener("pagehide", releaseOnHide);

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
  (item) => !conversations.value.some((c) => c.channel.channelID === item.wukongChannelId)
    && !batch.hiddenKeys.value.has(`${ChannelTypeGroup}:${item.wukongChannelId}`),
));

/** Agents tab: directory agents with no conversation yet, below the ones already talked to. */
const unopenedAgents = computed(() => railMode.value !== "agents" ? [] : uncontactedAgents(
  directoryAgents.value.filter((agent) => !batch.hiddenKeys.value.has(`${ChannelTypePerson}:${agent.uid}`)),
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
  searchOpen.value = false;
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
  hiddenOpen.value = false;
  batch.stopSelecting();
  void nextTick(() => document.querySelector<HTMLInputElement>("[data-testid=im-search-input]")?.focus());
}

function openDial(): void {
  dialOpen.value = true;
}

/** Every conversation search can name: the list plus the hidden ones (they carry a tag). */
const searchableConversations = computed(() => [...conversations.value, ...batch.hidden.value]);

function openFromSearch(channel: Channel, around?: number): void {
  searchOpen.value = false;
  void openChannel(channel, around);
}

async function searchContact(entry: DirectoryEntry): Promise<void> {
  const readSession = session.value;
  if (!readSession) return;
  try {
    openContact(entry.provisioned ? entry : await provisionContact(entry, readSession));
    searchOpen.value = false;
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : t("search.errFailed");
  }
}
const busy = computed(() => liveResponses.value.some((response) => response.status === "busy"));
const mentionQuery = computed(() => {
  if (activeChannel.value?.channelType !== ChannelTypeGroup) return null;
  const match = draft.value.match(/(?:^|\s)@([^@\s]*)$/);
  return match ? match[1].toLocaleLowerCase() : null;
});
const mentionSuggestions = computed(() => {
  if (mentionQuery.value === null) return [];
  return mentionCandidates(activeGroupMembers.value, session.value?.uid || "", mentionQuery.value);
});

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
let authRecoveryNeeded = false;
// Shell cross-tab revalidation in progress (see onAuth): view kept, nothing trusted.
// The shell bounds its own proof at 10 s; allow a little more before signing out.
const SHELL_REVALIDATION_MS = 12_000;
let revalidationTimer: ReturnType<typeof setTimeout> | undefined;
let revalidationPending = false;
// Set while an unproven revalidation token (pushed while offline) awaits the IM server's
// proof: the uid the re-mint must return for the view to resume. No stream meanwhile.
let proofUid: string | undefined;
// An unproven token refused while online (see adoptShellSession). teardownSession must
// NOT clear it: shellSignedOut sets it and then tears down.
let unprovenRejected: { token: string } | undefined;
// A re-mint that failed in transport (offline) is retried: by then the SDK socket is
// closed with reconnect off, so nothing else would bring the connection back. Bounded,
// single-flight, and never while a shell revalidation is pending (nothing is trusted then).
const REMINT_RETRY_MS = [2_000, 5_000, 10_000, 30_000, 30_000, 30_000];
let remintRetries = 0;
let remintRetryTimer: ReturnType<typeof setTimeout> | undefined;
let remintInFlight: [Promise<void>, unknown] | undefined;
const mayRemint = (current: unknown) => session.value === current && authRecoveryNeeded && !revalidationPending;
function remintWhenOnline(): void {
  if (session.value && mayRemint(session.value)) {
    remintRetries = 0;
    void remintConnectToken();
  }
}

// MUYU-161 D10: one web IM connection per account. Auth-fails that keep ending freshly
// re-minted connections mean another tab of this account took the connection; this tab then
// yields (view kept) and offers "use here" instead of displacing it back. While yielding, a
// renewal, `online`, a retry timer or the bar's reconnect never re-mint; a cross-tab
// revalidation re-mints only when the IM server must prove an unproven token (bounded: within
// the 2 min streak it yields again on the next quick loss, otherwise after another short round).
const conflict = connectionConflict();
const monotonicNow = () => performance.now();
// The last re-mint was refused (401/403): an explicit takeover then shows authFailed.
let remintRefused = false;
// The last re-mint failed in transport (offline, 5xx): a probe then returns to the conflict bar.
let remintTransportFailed = false;

// MUYU-161 D11: a yielded tab probes by itself (bounded, jittered, growing delays) unless another
// tab of this account in this browser reports a live connection; that tab keeps it. Tabs of other
// browsers cannot be heard: against them the probe budget alone bounds the displacement.
const tabId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID() : Math.random().toString(36).slice(2, 12);
const peers = peerLiveness();
const peerChannel = typeof BroadcastChannel === "undefined" ? undefined : new BroadcastChannel("nucleagent-im-connection");
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let probesUsed = 0;
let stableTimer: ReturnType<typeof setTimeout> | undefined;
let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
// This tab announced a live connection that it has not released yet.
let holding = false;
// An automatic probe (or "use here") is between its mint and its first connect: an auth-fail now
// means another tab took the connection first, so this tab yields again (no extra mint).
let probing = false;
function announce(state: "connected" | "released" | "query"): void {
  const uid = session.value?.uid;
  if (!uid || !peerChannel) return;
  try { peerChannel.postMessage({ uid, tab: tabId, state }); } catch { /* closed channel */ }
}
function heartbeat(): void {
  clearTimeout(heartbeatTimer);
  if (connection.value !== "connected") return;
  holding = true;
  announce("connected");
  heartbeatTimer = setTimeout(heartbeat, PEER_HEARTBEAT_MS);
}
function leaveConnected(): void {
  clearTimeout(heartbeatTimer);
  clearTimeout(stableTimer);
  if (holding) announce("released");
  holding = false;
}
/** Look again later without spending budget (live peer, offline, revalidation in progress). */
function scheduleRecheck(): void {
  clearTimeout(probeTimer);
  probeTimer = setTimeout(() => { if (connection.value === "conflict") scheduleProbe(); }, PEER_FRESH_MS);
}
function scheduleProbe(): void {
  clearTimeout(probeTimer);
  if (probesUsed >= PROBE_DELAYS_MS.length) return;
  const current = session.value;
  const delay = PROBE_DELAYS_MS[probesUsed] * (1 + Math.random() * PROBE_JITTER);
  probeTimer = setTimeout(() => {
    if (!current || session.value !== current) return;
    if (revalidationPending || connection.value !== "conflict" ||
      (typeof navigator !== "undefined" && navigator.onLine === false)) { scheduleRecheck(); return; }
    // Ask who holds the connection; a live holder answers at once even if its own timers are
    // throttled in the background. Decide after a short wait.
    announce("query");
    probeTimer = setTimeout(() => probeNow(current), peerChannel ? PEER_QUERY_WAIT_MS : 0);
  }, delay);
}
function probeNow(current: NonNullable<typeof session.value>): void {
  if (session.value !== current || connection.value !== "conflict" || revalidationPending) return;
  // A live peer keeps the connection. Its release (tab closed, signed out) re-arms the probe;
  // if it vanishes silently (crash), look again once its report has gone stale. No budget spent.
  if (peers.othersConnected(current.uid, tabId, monotonicNow())) { scheduleRecheck(); return; }
  probesUsed += 1;
  probing = true;
  conflict.probe();
  remint.reset();
  remint.take();
  remintRetries = 0;
  authRecoveryNeeded = true;
  connection.value = "connecting";
  void remintConnectToken().then(() => {
    if (session.value !== current || connection.value !== "connecting") return;
    // Refused (401/403): stop probing and say so; the next renewal or a sign-in decides.
    if (remintRefused) {
      probing = false;
      probesUsed = PROBE_DELAYS_MS.length;
      connection.value = "authFailed";
    } else if (probing && remintTransportFailed) {
      // Transport failure: give the connection back to the bar (still yielded) and probe later.
      probing = false;
      clearTimeout(remintRetryTimer);
      authRecoveryNeeded = false;
      connection.value = "conflict";
      scheduleProbe();
    }
  });
}
function onPeerMessage(event: MessageEvent): void {
  if (!isPeerReport(event.data) || event.data.tab === tabId) return;
  const uid = session.value?.uid;
  if (event.data.state === "query") {
    // A probing tab answers too: two yielded tabs of this browser never mint together.
    if (uid === event.data.uid && (connection.value === "connected" || probing)) announce("connected");
    return;
  }
  const handedOver = peers.heard(event.data, monotonicNow());
  if (handedOver && connection.value === "conflict" && uid === event.data.uid) scheduleProbe();
}
peerChannel?.addEventListener("message", onPeerMessage);

const connectStatusListener: ConnectStatusListener = (status, reasonCode) => {
  if (status === ConnectStatus.Connected) {
    connection.value = "connected";
    authRecoveryNeeded = false;
    remint.reset();
    conflict.connected(monotonicNow());
    probing = false;
    clearTimeout(probeTimer);
    heartbeat();
    // The probe budget is earned back only by a connection that holds.
    clearTimeout(stableTimer);
    stableTimer = setTimeout(() => { probesUsed = 0; }, CONFLICT_WINDOW_MS);
    void Promise.all([syncConversations(), syncGroups(), refreshActiveHistory(), batch.refreshHidden()]);
    void openPendingConversation();
    void refreshAgentPresentation();
    void readAgentCapabilities();
  } else if (status === ConnectStatus.Connecting) {
    connection.value = "connecting";
  } else if (status === ConnectStatus.ConnectFail && reasonCode === 2) {
    leaveConnected();
    const lostProbe = probing;
    probing = false;
    if (conflict.authFailed(monotonicNow()) || lostProbe) {
      conflict.yieldNow();
      connection.value = "conflict";
      authRecoveryNeeded = false;
      clearTimeout(remintRetryTimer);
      scheduleProbe();
      return;
    }
    connection.value = "authFailed";
    authRecoveryNeeded = true;
    if (remint.take()) void remintConnectToken();
  } else {
    if (status === ConnectStatus.Disconnect) conflict.lost(monotonicNow());
    leaveConnected();
    // The refused socket closing after a yield must not turn the bar back into 重连.
    connection.value = conflict.yielded() ? "conflict" : "disconnected";
  }
};

/** The conflict bar's "use here": take the connection back once, with a bounded allowance. */
function takeOverConnection(): void {
  const current = session.value;
  if (!current || connection.value !== "conflict" || revalidationPending) return;
  clearTimeout(probeTimer);
  probing = true;
  conflict.takeOver();
  remint.reset();
  remint.take();
  remintRetries = 0;
  authRecoveryNeeded = true;
  connection.value = "connecting";
  void remintConnectToken().then(() => {
    if (session.value === current && remintRefused && connection.value === "connecting") {
      probing = false;
      connection.value = "authFailed";
    }
  });
}

const conversationListener: ConversationListener = (conversation, action) => {
  if (action === ConversationAction.remove) {
    const key = channelKey(conversation.channel);
    conversations.value = conversations.value.filter((item) => channelKey(item.channel) !== key);
    return;
  }
  // A message from someone else un-hides the row on the server; the viewer's own does not.
  if (!batch.receive(conversation, session.value?.uid || "")) return;
  upsertConversation(conversation);
  // IM-FIX-1: a group the viewer was just added to is not in `groups` until listGroups runs again.
  if (unknownGroup(conversation.channel, groups.value)) void refreshGroups();
};

const messageListener: MessageListener = (message) => {
  if (activeChannel.value?.isEqual(message.channel)) {
    messages.value = mergeMessages(messages.value, [message]);
    reconcileResponses();
    scrollToBottom();
    // R6: the server counted it unread; the user is looking at it.
    if (!isOwnMessage(message)) markChannelRead(message.channel);
    // IM-FIX-1: no member-change event reaches the client; a sender the list lacks means it is stale.
    const group = activeGroup.value;
    if (group && activeGroupMembers.value.length && message.fromUID
      && !activeGroupMembers.value.some((member) => String(member.uid) === message.fromUID)) {
      void refreshMembers(group);
    }
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
  void refreshAgentPresentation();
  clearTimeout(directoryTimer);
  const epoch = ++directoryEpoch;
  directoryTimer = setTimeout(() => pollAgentDirectory(epoch), 2000);
  void readAgentCapabilities();
  const sdk = configureSDK(nextSession, () => session.value);
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
    clearTimeout(revalidationTimer);
    if (intent.revalidating && session.value) {
      // Another shell tab stored a credential and the shell is re-proving it
      // (cross-tab sync, e.g. that tab refreshed). This is not a sign-out: keep the
      // view (draft, history, scroll) but trust nothing meanwhile — no socket, no
      // stream — until the proven token arrives. If it never does, sign out.
      revalidationPending = true;
      clearTimeout(remintRetryTimer);
      streamAbort?.abort();
      WKSDK.shared().disconnect();
      connection.value = "connecting";
      const generation = shellAuthGeneration;
      revalidationTimer = setTimeout(() => {
        if (generation === shellAuthGeneration) shellSignedOut();
      }, SHELL_REVALIDATION_MS);
      return;
    }
    if (!intent.token) {
      shellSignedOut();
      return;
    }
    void adoptShellSession(intent.token, intent.principal);
  },
});

function shellSignedOut(): void {
  revalidationPending = false;
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
}

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

const disposeEmbedHost = installEmbedHost({
  onInit() {
    agentiaHosted.value = true;
    clearTimeout(shellLoginTimer);
    loginError.value = "";
    if (!session.value) loggingIn.value = true;
  },
  onCredential(accessToken) {
    shellAuthGeneration += 1;
    if (accessToken) {
      // The agentia host has no revalidation/principal protocol: principal stays undefined,
      // so the shell-only proven-principal guard in adoptShellSession does not apply here.
      void adoptShellSession(accessToken);
      return;
    }
    loggingIn.value = false;
    loginError.value = t("login.errFailed");
  },
  onRevoke() {
    shellAuthGeneration += 1;
    loggingIn.value = false;
    const jwt = session.value?.jwt;
    if (session.value) {
      clearCachedContacts(session.value.uid);
      clearCachedProfile(session.value.uid);
      teardownSession();
    }
    return jwt;
  },
});

async function adoptShellSession(accessToken: string, principal?: string | null): Promise<void> {
  const generation = shellAuthGeneration;
  // A proof still pending (unproven token, offline) is also a resume: a proven token for
  // this same user completes it (re-mint, reconnect, reopen the stream).
  const resuming = revalidationPending || (proofUid !== undefined && typeof principal === "string");
  revalidationPending = false;
  // A revalidation ends on a proven credential. If the shell's cross-tab proof failed it
  // still pushes the stored token, unproven (principal null):
  //  - while ONLINE the proof failure means the server refused it (revoked/expired): fail
  //    closed as a sign-out, and the duplicate copy of that token cannot sign in afresh;
  //  - while OFFLINE the failure proves nothing: keep the view without socket or stream and
  //    let the IM server prove the token once back online — resume only on this same uid,
  //    sign out on a refusal (401/403) or another uid (see remintOnce).
  // A token proven for another user is an account switch: tear the old view down.
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  if (resuming && principal !== undefined && principal !== session.value?.uid && (principal !== null || !offline)) {
    if (principal === null) unprovenRejected = { token: accessToken };
    shellSignedOut();
    return;
  }
  if (unprovenRejected && accessToken === unprovenRejected.token && (principal === undefined || principal === null)) {
    return;
  }
  unprovenRejected = undefined;
  const serverProof = resuming && principal === null;
  // Only a credential the shell PROVED for a user ends a pending server proof; a duplicate
  // or field-less copy of the unproven token must leave it (and its 401 sign-out) in force.
  if (typeof principal === "string") proofUid = undefined;
  if (session.value?.jwt === accessToken && !resuming) return;
  // Same user (the routine renewal): swap the login token, keep the socket and its IM token.
  // If WuKongIM ever rejects that token, remintConnectToken mints from this fresh session.jwt.
  if (session.value && renewsSameUser(session.value, accessToken)) {
    session.value = { ...session.value, jwt: accessToken };
    // A revalidation closed the socket and stream: re-mint and reconnect (the
    // Connected listener re-syncs history), then reopen the open channel's stream.
    // An earlier remint may also have failed with the expired shell credential.
    // Mark a resume as pending recovery so a failed re-mint retries on the next
    // renewal instead of leaving the view stuck (Connected clears it).
    // A tab that yielded the connection to another tab stays yielded across a revalidation,
    // unless the IM server has to prove an unproven token (that needs one mint).
    const stayYielded = resuming && conflict.yielded() && !serverProof;
    if (resuming && !stayYielded) authRecoveryNeeded = true;
    if (stayYielded) { connection.value = "conflict"; if (!authRecoveryNeeded) scheduleProbe(); }
    if (serverProof) proofUid = session.value.uid;
    remintRetries = 0; // a new credential earns a fresh, still bounded, retry budget
    const resumedUid = session.value.uid;
    if (authRecoveryNeeded) await remintConnectToken();
    // The shell delivers each intent twice, so the generation may have moved on by a
    // duplicate of this same token; what matters is that it is still this user's
    // session and no newer revalidation or sign-out has started.
    if (resuming && session.value?.uid === resumedUid && !revalidationPending && proofUid === undefined &&
      !serverProof && activeChannel.value) {
      startAgentStream(activeChannel.value, viewGeneration);
    }
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
  const current = session.value;
  try {
    const next = await WKSDK.shared().conversationManager.sync();
    if (session.value !== current) return;
    conversations.value = next;
    hasMoreConversations.value = true;
  } catch (error) {
    if (session.value !== current) return;
    loginError.value = error instanceof Error ? error.message : t("chat.errConversations");
  }
}

// Q3: the list is cursor-paged (50 per page). Scrolling near the bottom loads the next page.
function mergeConversationPage(page: Conversation[]): void {
  const known = new Set(conversations.value.map((item) => channelKey(item.channel)));
  const fresh = page.filter((item) => !known.has(channelKey(item.channel)));
  conversations.value = [...conversations.value, ...fresh];
  const sdk = WKSDK.shared().conversationManager;
  const sdkKnown = new Set(sdk.conversations.map((item) => channelKey(item.channel)));
  sdk.conversations = [...sdk.conversations, ...page.filter((item) => !sdkKnown.has(channelKey(item.channel)))];
}

async function loadMoreConversationPage(): Promise<void> {
  const pageSession = session.value;
  if (!pageSession || loadingConversations.value || !hasMoreConversations.value) return;
  loadingConversations.value = true;
  try {
    const page = await loadMoreConversations(pageSession);
    if (session.value !== pageSession) return;
    hasMoreConversations.value = page.length > 0;
    mergeConversationPage(page);
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
  // Single flight per session: duplicate triggers (online + timer + renewal) for the same
  // credential share one mint. A newer credential mints at once; the older mint's result
  // is fenced by the session check in remintOnce.
  if (remintInFlight && remintInFlight[1] === session.value) return remintInFlight[0];
  const flight: Promise<void> = remintOnce().finally(() => {
    if (remintInFlight?.[0] === flight) remintInFlight = undefined;
  });
  remintInFlight = [flight, session.value];
  return flight;
}

async function remintOnce(): Promise<void> {
  const current = session.value;
  if (!current) return;
  clearTimeout(remintRetryTimer);
  remintRefused = false;
  remintTransportFailed = false;
  let proofPassed = false;
  try {
    const next = await imSession({ accessToken: current.jwt });
    if (session.value !== current || revalidationPending) return;
    if (proofUid !== undefined) {
      const expected = proofUid;
      proofUid = undefined;
      // The server resolved the unproven credential to another account: never resume
      // the old view on it.
      if (next.uid !== expected) { shellSignedOut(); return; }
      proofPassed = true;
    }
    remintRetries = 0;
    remintRefused = false;
    session.value = next;
    WKSDK.shared().disconnect(); // close the refused socket before the SDK opens a new one
    const sdk = configureSDK(next, () => session.value);
    connection.value = "connecting";
    sdk.connect();
    // The open channel's stream waited for the server's proof (see adoptShellSession).
    if (proofPassed && activeChannel.value) startAgentStream(activeChannel.value, viewGeneration);
  } catch (error) {
    // Keep recovery pending even if socket close has changed the displayed status.
    // A transport failure (offline, blip: fetch rejects with TypeError) is retried with
    // bounded backoff and on `online`; a server refusal is not — the next renewal retries that.
    // Only an explicit 401/403 is a refusal; 5xx, gateway pages and network errors are
    // transport failures and are retried (bounded).
    const status = (error as { status?: number } | undefined)?.status;
    const refused = status === 401 || status === 403;
    const transport = !refused;
    if (session.value === current) remintRefused = refused;
    if (session.value === current) remintTransportFailed = transport;
    // The server refused the unproven credential (revoked, expired): fail closed.
    if (refused && proofUid !== undefined && session.value === current && !revalidationPending) {
      proofUid = undefined;
      shellSignedOut();
      return;
    }
    if (transport && mayRemint(current) &&
      remintRetries < REMINT_RETRY_MS.length) {
      const delay = REMINT_RETRY_MS[remintRetries++];
      remintRetryTimer = setTimeout(() => {
        if (mayRemint(current)) void remintConnectToken();
      }, delay);
    }
  }
}

// R5: messages sent while the WS was down never reach this tab live. On (re)connect, pull the
// open channel's latest page again and merge it; an initial connect with no chat open is a no-op.
async function refreshActiveHistory(): Promise<void> {
  const current = session.value;
  const channel = activeChannel.value;
  if (!channel || loadingHistory.value) return;
  const generation = viewGeneration;
  try {
    const latest = await WKSDK.shared().chatManager.syncMessages(channel, {
      limit: 30, startMessageSeq: 0, endMessageSeq: 0, pullMode: PullMode.Up,
    });
    if (generation !== viewGeneration || session.value !== current) return;
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

// IM-FIX-1: event-driven refreshes, at most one listGroups / one member read per group every 3 s.
const groupsOnce = throttle(3000);
const membersOnce = throttle(3000);
const refreshGroups = () => groupsOnce("groups", syncGroups);
const refreshMembers = (group: IMGroup) =>
  membersOnce(String(group.id), () => loadActiveGroupMembers(group, viewGeneration));

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
  // No stream on an unproven credential (revalidation or server proof pending).
  if (!session.value || revalidationPending || proofUid !== undefined) return;

  streamAbort = new AbortController();
  const streamSession = session.value;
  let streamJwt = streamSession.jwt;
  void connectAgentStream({
    baseUrl: imBase,
    channelId: browserStreamChannelId(channel.channelID, channel.channelType, streamSession.uid),
    channelType: channel.channelType,
    jwt: streamJwt,
    signal: streamAbort.signal,
    // Embedded: the shell's newest push for this same user; never another user's.
    currentToken: () => {
      if (!shellOwnsSession() || session.value?.uid !== streamSession.uid) return undefined;
      streamJwt = session.value.jwt;
      return streamJwt;
    },
    async refreshToken() {
      // Embedded, the refresh cookie lives on the shell's origin, not ours. Use the
      // newer token the shell has already pushed (adoptShellSession), or report the
      // rejection once and wait for that push. Retrying the rejected token is the
      // repeated-401 loop; another user's session is never borrowed.
      if (shellOwnsSession()) {
        streamJwt = await nextShellCredential(
          () => (session.value?.uid === streamSession.uid ? session.value.jwt : undefined),
          streamJwt,
          () => shellBridge.reportAuthRequired("rejected"),
        );
        return streamJwt;
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

// IM3-D5 (S2): a message hit opens its chat around that message and highlights it for 2 s.
const locateMs = 2000;
const locatedSeq = ref(0);
let locateTimer: ReturnType<typeof setTimeout> | undefined;
function locate(seq: number): void {
  clearTimeout(locateTimer);
  locatedSeq.value = seq;
  void nextTick(() => chatElement.value?.querySelector(`[data-seq="${seq}"]`)?.scrollIntoView({ block: "center" }));
  locateTimer = setTimeout(() => { locatedSeq.value = 0; }, locateMs);
}

async function openChannel(channel: Channel, around?: number): Promise<void> {
  // There is no chat with yourself: im refuses the uid@uid pair (403), so say why instead.
  if (channel.channelType === ChannelTypePerson && channel.channelID === String(session.value?.uid ?? "")) {
    loginError.value = t("chat.selfChat");
    return;
  }
  viewGeneration += 1;
  const generation = viewGeneration;
  activeChannel.value = channel;
  activeGroupMembers.value = [];
  messages.value = [];
  draft.value = "";
  mentionedAgentUids.value = [];
  mentionedPersonUids.value = [];
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
  } else if (unknownGroup(channel, groups.value)) {
    // syncGroups loads the members once the group is listed (still this channel, none loaded yet).
    void refreshGroups();
  }

  try {
    if (around) {
      // messagesync is keyed by message_seq (reads.go channelMessages): Down = at or before, Up = at or after.
      // ponytail: newer than 30 after the hit are not loaded; reopening the chat shows the latest.
      const sync = WKSDK.shared().chatManager;
      const [older, newer] = await Promise.all([
        sync.syncMessages(channel, { limit: 30, startMessageSeq: around, endMessageSeq: 0, pullMode: PullMode.Down }),
        sync.syncMessages(channel, { limit: 30, startMessageSeq: around, endMessageSeq: 0, pullMode: PullMode.Up }),
      ]);
      if (generation !== viewGeneration) return;
      messages.value = mergeMessages(older, newer);
      reconcileResponses();
      historyFinished.value = older.length < 30;
      locate(around);
      return;
    }
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

function insertMention(member: GroupMember): void {
  const name = member.displayName || member.username;
  draft.value = draft.value.replace(/@[^@\s]*$/, `@${name} `);
  const uid = String(member.uid);
  const list = member.accountType === "agent" ? mentionedAgentUids : mentionedPersonUids;
  if (!list.value.includes(uid)) list.value = [...list.value, uid];
}

function removeMention(uid: string): void {
  mentionedAgentUids.value = mentionedAgentUids.value.filter((item) => item !== uid);
  mentionedPersonUids.value = mentionedPersonUids.value.filter((item) => item !== uid);
}

async function sendMessage(): Promise<void> {
  const text = draft.value.trim();
  const channel = activeChannel.value;
  const sendSession = session.value;
  if (!text || !channel || !sendSession || sending.value || connection.value !== "connected") return;

  const generation = viewGeneration;
  const originalDraft = draft.value;
  const mentionUids = mentionedAgentUids.value;
  const personUids = mentionedPersonUids.value;
  const current = () => generation === viewGeneration && session.value === sendSession
    && connection.value === "connected" && draft.value === originalDraft
    && mentionedAgentUids.value === mentionUids && mentionedPersonUids.value === personUids;
  sending.value = true;
  recipientDisabled.value = false;
  try {
    const outcome = await sendToEnabledRecipient(channel, sendSession, current, async () => {
      const content = buildOutgoingText(text, channel.channelType, mentionUids, personUids);
      // The SDK shows it at once (message listener); the draft goes only once it is on the server.
      const message = await sendAcked(content, channel);
      // Finish the bounded projection check before "sent" lets the user close this tab.
      const conversation = await reconcileAckedConversation(channel, sendSession);
      if (session.value === sendSession && conversation) mergeConversationPage([conversation]);
      if (!current()) return;
      draft.value = "";
      mentionedAgentUids.value = [];
      mentionedPersonUids.value = [];
      messages.value = mergeMessages(messages.value, [message]);
      scrollToBottom();
    }, mentionUids);
    if (current()) recipientDisabled.value = outcome === "disabled";
    if (outcome === "disabled" && channel.channelType === ChannelTypePerson && isAgentUid(channel.channelID)) {
      peerUnavailable.value = true;
    }
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
  if (!session.value) return;
  // uid 0 is nobody's (a not-yet-joined directory row): address by openId/portalUid instead.
  if (target.uid === "0") target = { ...target, uid: "" };
  // Nothing to address the card by: say so, never a click that does nothing.
  if (!(target.uid || target.openId || target.portalUid)) {
    loginError.value = t("profile.unavailable");
    return;
  }
  const uid = target.uid;
  // UNI-OID: IM rows know a uid; pass the Open ID too when resolve already named it (D2: none for agents).
  const openId = target.openId || (uid ? openIdOf(uid) || undefined : undefined);
  const channel = activeChannel.value;
  const can = profileActions(target, {
    selfUid: session.value.uid,
    dmUid: channel?.channelType === ChannelTypePerson ? channel.channelID : undefined,
    inGroup: groupDialogOpen.value && !!dialogGroup.value,
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
  const opener = session.value;
  void accountUi.openProfile(anchor, profileParams(session.value, getLocale(), {
    openId, uid, portalUid: openId ? undefined : target.portalUid, known: target.known, host: target.host,
    onSelect: can.select ? target.select : undefined,
    onMessage: can.message ? () => void (target.message ?? message)() : undefined,
    onAddToGroup: !can.addToGroup ? undefined : () => {
      groupDialogOpen.value = false;
      void nextTick(() => showCreateGroup([contact()]));
    },
  // account-ui could not load: say so rather than a click that does nothing.
  })).then((shown) => { if (!shown && session.value === opener) loginError.value = t("profile.unavailable"); });
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
  proofUid = undefined;
  revalidationPending = false;
  clearTimeout(revalidationTimer);
  clearTimeout(remintRetryTimer);
  remintRetries = 0;
  authRecoveryNeeded = false;
  remint.reset();
  conflict.reset();
  remintRefused = false;
  leaveConnected();
  clearTimeout(probeTimer);
  probesUsed = 0;
  probing = false;
  remintTransportFailed = false;
  peers.clear();
  viewGeneration += 1;
  streamAbort?.abort();
  removeListeners();
  WKSDK.shared().disconnect();
  WKSDK.shared().conversationManager.openConversation = undefined;
  session.value = undefined;
  managementOpen.value = false;
  canManageAgents.value = false;
  conversations.value = [];
  groups.value = [];
  directoryAgents.value = [];
  agentDirectory.clear();
  directoryEpoch++;
  directoryReading = undefined;
  directoryError.value = false;
  clearTimeout(directoryTimer);
  knownContacts.value = [];
  resetNames();
  batch.reset();
  menu.value = undefined;
  listMenuOpen.value = false;
  hiddenOpen.value = false;
  searchOpen.value = false;
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
  if (agentiaHosted.value) {
    // Never navigate the host's frame away; the account page opens beside it.
    window.open(shellAccountUrl(), "_blank", "noopener");
    return;
  }
  if (embedded) {
    shellBridge.requestAccount();
    return;
  }
  window.location.assign(shellAccountUrl());
}

function signOut(): void {
  if (agentiaHosted.value) {
    // No shell to delegate to: end this session here, as the host's revoke would.
    const jwt = session.value?.jwt;
    if (session.value) {
      clearCachedContacts(session.value.uid);
      clearCachedProfile(session.value.uid);
      teardownSession();
    }
    revokeServerSession(jwt);
    return;
  }
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
  window.removeEventListener("pagehide", releaseOnHide);
  peerChannel?.removeEventListener("message", onPeerMessage);
  shellBridge.dispose();
  disposeEmbedHost();
  document.removeEventListener("keydown", onKeydown);
  document.removeEventListener("visibilitychange", onVisible);
  window.removeEventListener("focus", rereadAgentDirectory);
  window.removeEventListener("online", rereadAgentDirectory);
  window.removeEventListener("online", remintWhenOnline);
  clearTimeout(remintRetryTimer);
  clearTimeout(pressTimer);
  clearTimeout(locateTimer);
  teardownSession();
  peerChannel?.close();
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
      <p v-if="loginError" role="alert">{{ loginError }}</p>
      <p v-else-if="!loggingIn">{{ t("login.redirectingBody") }}</p>
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
  <!-- Phones: the open chat covers the sidebar, except while the search page (which lives there) is open. -->
  <main v-else class="app-shell" :class="{ 'show-chat': activeChannel && !searchOpen }">
    <nav class="rail" :aria-label="t('app.title')">
      <span class="rail-brand" :title="t('app.title')">N</span>

      <button
        class="rail-btn"
        :class="{ active: !searchOpen && railMode === 'all' }"
        type="button"
        :title="t('list.all')"
        :aria-label="t('list.all')"
        :aria-pressed="!searchOpen && railMode === 'all'"
        @click="selectRail('all')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z" /></svg>
        <span class="rail-label">{{ t("tab.chats") }}</span>
        <span v-if="totalUnread" class="rail-dot" />
      </button>
      <button
        class="rail-btn"
        :class="{ active: !searchOpen && railMode === 'groups' }"
        type="button"
        :title="t('list.groups')"
        :aria-label="t('list.groups')"
        :aria-pressed="!searchOpen && railMode === 'groups'"
        @click="selectRail('groups')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 21v-2a4 4 0 00-4-4H8a4 4 0 00-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
        <span class="rail-label">{{ t("tab.groups") }}</span>
      </button>
      <!-- Agents get their own slot because that is the one thing this product
           has that a generic IM does not. -->
      <button
        class="rail-btn"
        :class="{ active: !searchOpen && railMode === 'agents' }"
        type="button"
        :title="t('list.agents')"
        :aria-label="t('list.agents')"
        :aria-pressed="!searchOpen && railMode === 'agents'"
        @click="selectRail('agents')"
      >
        <svg class="rail-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2L4 7v10l8 5 8-5V7l-8-5z" /><path d="M12 22V12" /><path d="M4 7l8 5 8-5" /></svg>
        <span class="rail-label">{{ t("tab.agents") }}</span>
      </button>
      <button
        class="rail-btn"
        :class="{ active: searchOpen }"
        type="button"
        :title="t('list.searchPlaceholder')"
        :aria-label="t('list.searchPlaceholder')"
        :aria-pressed="searchOpen"
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
        <button v-if="canManageAgents" type="button" class="icon-button" data-testid="im-agent-management"
          :title="definitionText('title', getLocale())" :aria-label="definitionText('title', getLocale())"
          @click="managementOpen = true"><Settings2 :size="20" /></button>
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
        <!-- A div, not a span: phones hide every .sidebar-header span (the connection words). -->
        <div class="list-menu-wrap">
          <button
            class="icon-button"
            type="button"
            data-testid="im-list-menu"
            :title="t('hide.listMenu')"
            :aria-label="t('hide.listMenu')"
            aria-haspopup="menu"
            :aria-expanded="listMenuOpen"
            @click="listMenuOpen = !listMenuOpen"
          >⋯</button>
          <div v-if="listMenuOpen" class="row-menu list-menu" role="menu">
            <button type="button" role="menuitem" data-testid="im-select-start" @click="startSelecting">{{ t("hide.select") }}</button>
            <button type="button" role="menuitem" data-testid="im-hidden-entry" @click="openHiddenView">{{ t("hide.hiddenList", { count: batch.hidden.value.length }) }}</button>
          </div>
        </div>
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
        <button v-if="connection === 'conflict'" type="button" data-testid="im-conflict-take-over" @click="takeOverConnection">{{ t("system.useHere") }}</button>
      </p>

      <div v-show="!searchOpen" class="sidebar-tools">
        <!-- IM3-D5: one entry to the search page (it replaces the list while open). -->
        <input
          class="contact-search search-trigger"
          type="search"
          readonly
          data-testid="im-search-trigger"
          :placeholder="t('list.searchPlaceholder')"
          :aria-label="t('list.searchPlaceholder')"
          @focus="focusSearch"
          @click="focusSearch"
        >
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

      <div v-if="batch.selecting.value" class="select-bar" role="toolbar" data-testid="im-select-bar" :aria-label="t('hide.select')">
        <span data-testid="im-selected-count">{{ t("hide.selected", { count: batch.selected.value.size }) }}</span>
        <button type="button" class="quiet" data-testid="im-select-all" @click="batch.selectAll(visibleConversations.map((item) => channelKey(item.channel)))">{{ t("hide.selectAll") }}</button>
        <button type="button" class="quiet" data-testid="im-select-hide" :disabled="!batch.selected.value.size || batch.busy.value" @click="batch.runSelected('hide')">{{ t("hide.hide") }}</button>
        <button type="button" class="quiet" data-testid="im-select-read" :disabled="!batch.selected.value.size || batch.busy.value" @click="batch.runSelected('read')">{{ t("hide.markRead") }}</button>
        <button type="button" class="quiet" data-testid="im-select-cancel" @click="batch.stopSelecting()">{{ t("hide.cancel") }}</button>
      </div>

      <section v-if="hiddenOpen && !searchOpen" class="hidden-view" data-testid="im-hidden-view" :aria-label="t('hide.hiddenTitle')">
        <header class="hidden-view-head">
          <button class="icon-button" type="button" data-testid="im-hidden-back" :aria-label="t('hide.back')" @click="hiddenOpen = false">‹</button>
          <strong>{{ t("hide.hiddenList", { count: batch.hidden.value.length }) }}</strong>
        </header>
        <div v-for="conversation in batch.hidden.value" :key="channelKey(conversation.channel)" class="conversation-row" data-testid="im-hidden-row">
          <button class="conversation" type="button" @click="openChannel(conversation.channel)">
            <RowAvatar
              :id="conversation.channel.channelID"
              :name="conversationTitle(conversation)"
              :kind="conversationKind(conversation)"
              :unnamed="isResolving(conversation)"
            />
            <span class="conversation-copy">
              <span class="conversation-name">
                <strong v-if="isResolving(conversation)" class="name-skeleton" :aria-label="t('chat.loading')" />
                <strong v-else>{{ conversationTitle(conversation) }}</strong>
              </span>
              <small>{{ conversationSubtitle(conversation) || t("empty.noMessages") }}</small>
            </span>
          </button>
          <button
            class="quiet unhide"
            type="button"
            data-testid="im-unhide"
            :disabled="batch.busy.value"
            @click="batch.run('unhide', [channelKey(conversation.channel)])"
          >{{ t("hide.unhide") }}</button>
        </div>
        <p v-if="!batch.hidden.value.length" class="empty-list">{{ t("hide.hiddenEmpty") }}</p>
      </section>

      <SearchPanel
        v-if="searchOpen"
        :session="session"
        :conversations="searchableConversations"
        :hidden-keys="batch.hiddenKeys.value"
        :agents="directoryAgents"
        :title-for="conversationTitle"
        @close="searchOpen = false"
        @conversation="(conversation) => openFromSearch(conversation.channel)"
        @contact="searchContact"
        @agent="(agent) => { searchOpen = false; openAgent(agent); }"
        @message="(hit) => openFromSearch(hit.channel, hit.seq)"
        @profile="openProfile"
      />

      <nav class="conversation-list" v-show="!hiddenOpen && !searchOpen" :aria-label="t('list.all')" @scroll.passive="conversationListScrolled">
        <p v-if="directoryError && railMode === 'agents'" role="status" class="empty-list">{{ definitionText('directoryError', getLocale()) }}</p>
        <div
          v-for="conversation in visibleConversations"
          :key="channelKey(conversation.channel)"
          class="conversation-row"
          @contextmenu.prevent="openRowMenu(conversation, $event)"
          @pointerdown="pressStart(conversation, $event)"
          @pointerup="pressEnd"
          @pointercancel="pressEnd"
          @pointerleave="pressEnd"
        >
        <!-- Direct chat: the avatar is its own control, a sibling over the
             avatar column (no button-in-button), opening that person's card;
             the row still opens the chat (UNI-AVATAR-CARD-R2). Groups: none. -->
        <button
          v-if="conversation.channel.channelType === ChannelTypePerson && !isResolving(conversation) && !batch.selecting.value"
          class="avatar-trigger"
          type="button"
          data-testid="im-row-avatar-profile"
          :aria-label="t('profile.view', { name: conversationTitle(conversation) })"
          @click="personProfile(conversation.channel.channelID, $event.currentTarget as HTMLElement)"
        />
        <button
          class="conversation"
          :class="{ active: activeChannel?.isEqual(conversation.channel), selected: batch.selecting.value && batch.selected.value.has(channelKey(conversation.channel)) }"
          type="button"
          :role="batch.selecting.value ? 'checkbox' : undefined"
          :aria-checked="batch.selecting.value ? batch.selected.value.has(channelKey(conversation.channel)) : undefined"
          @click="rowClicked(conversation)"
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
            <small><span v-if="conversation.unread && mentionsMe(conversation.lastMessage?.content, session?.uid || '')" class="mention-me-tag" data-testid="mention-me">{{ t("list.mentionMe") }}</span>{{ conversationSubtitle(conversation) || t("empty.noMessages") }}</small>
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
        <button
          v-if="!batch.selecting.value"
          class="row-more"
          type="button"
          data-testid="im-row-more"
          :aria-label="t('hide.rowMenu', { name: conversationTitle(conversation) })"
          aria-haspopup="menu"
          @click.stop="openRowMenu(conversation, $event)"
        >⋯</button>
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
          <button v-if="activeAgentUid" type="button" class="icon-button"
            :title="getLocale() === 'zh' ? '有效定义' : 'Effective definition'"
            :aria-label="getLocale() === 'zh' ? '有效定义' : 'Effective definition'"
            :aria-expanded="effectiveOpen" aria-controls="im-agent-effective"
            @click="effectiveOpen = !effectiveOpen"><Info :size="20" /></button>
          <span v-if="busy" class="busy-chip">
            <span class="blip" aria-hidden="true" />
            {{ t("chat.responding", { name: respondingAgent || t("badge.agent") }) }}
          </span>
          <button v-if="activeGroup" class="quiet" type="button" @click="showGroupDetails">
            {{ t("chat.members") }}
          </button>
          <button
            v-if="activeChannel"
            class="icon-button"
            type="button"
            data-testid="im-chat-menu"
            :title="t('hide.chatMenu')"
            :aria-label="t('hide.chatMenu')"
            aria-haspopup="menu"
            @click="openChatMenu($event)"
          >⋯</button>
        </div>
      </header>
      <div v-if="activeAgentUid && effectiveOpen" id="im-agent-effective" class="agent-effective-panel">
        <AgentEffective :key="`${session?.uid}:${activeAgentUid}`" :api="agentEffective" kind="uid" :id="activeAgentUid" />
      </div>

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

          <template v-for="message in messages" :key="messageKey(message)">
          <SystemLine v-if="isAgentUnavailableNotice(message.content)" calm data-testid="agent-unavailable-notice">
            {{ t("system.agentUnavailable") }}<br><small>{{ t("system.agentUnavailableHint") }}</small>
          </SystemLine>
          <SystemLine v-else-if="isExecutionFailedNotice(message.content)" calm data-testid="agent-failed-notice">
            {{ rejectionCopy("im_execution_failed", getLocale()) }}
          </SystemLine>
          <article
            v-else
            class="message"
            :class="{ own: isOwnMessage(message), agent: isAgentMessage(message), located: message.messageSeq === locatedSeq }"
            :data-seq="message.messageSeq"
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
              <div class="bubble" :class="{ 'mention-me': !isOwnMessage(message) && mentionsMe(message.content, session?.uid || '') }">{{ messageText(message) }}</div>
              <time>{{ messageTime(message) }}</time>
            </span>
          </article>
          </template>

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
            <div v-if="mentionedAgentUids.length || mentionedPersonUids.length" class="mention-chips">
              <button
                v-for="uid in [...mentionedAgentUids, ...mentionedPersonUids]"
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
                v-for="member in mentionSuggestions"
                :key="member.uid"
                type="button"
                role="option"
                @click="insertMention(member)"
              >
                <span class="mention-who">
                  <img v-if="member.avatar" :src="member.avatar" alt="" />
                  <strong>{{ member.displayName || member.username }}</strong>
                </span>
                <span :class="{ person: member.accountType !== 'agent' }">{{ t(member.accountType === "agent" ? "badge.agent" : "badge.member") }}</span>
              </button>
            </div>
            <textarea
              v-model="draft"
              :readonly="sending"
              :disabled="peerUnavailable"
              :aria-label="t('composer.label')"
              :placeholder="peerUnavailable ? t('composer.agentDisabled') : activeAgents.length ? t('composer.placeholderAgents') : t('composer.placeholder')"
              rows="2"
              @keydown.enter.exact.prevent="sendMessage"
            />
          </div>
          <button
            class="primary send"
            type="submit"
            :disabled="sending || peerUnavailable || !draft.trim() || connection !== 'connected'"
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
            <span v-if="activeGroupMembers.length > 1"><kbd>@</kbd> {{ t("composer.hintMention") }}</span>
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
    <!-- IM3-D4: one row menu (⋯, right-click, long-press, chat header). -->
    <div v-if="menu || listMenuOpen" class="menu-scrim" @click="menu = undefined; listMenuOpen = false" @contextmenu.prevent="menu = undefined" />
    <div v-if="menu" class="row-menu" role="menu" data-testid="im-row-menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
      <button
        v-if="batch.hiddenKeys.value.has(channelKey(menu.conversation.channel))"
        type="button"
        role="menuitem"
        data-testid="im-menu-unhide"
        @click="menuAction('unhide')"
      >{{ t("hide.unhide") }}</button>
      <button v-else type="button" role="menuitem" data-testid="im-menu-hide" @click="menuAction('hide')">{{ t("hide.hideChat") }}</button>
      <button v-if="menu.conversation.unread" type="button" role="menuitem" data-testid="im-menu-read" @click="menuAction('read')">{{ t("hide.markRead") }}</button>
      <button v-if="!menu.header" type="button" role="menuitem" data-testid="im-menu-select" @click="menuAction('select')">{{ t("hide.select") }}</button>
    </div>
    <p
      v-if="batch.notice.value"
      class="notice-toast"
      role="status"
      @mouseenter="batch.pauseNotice()"
      @mouseleave="batch.resumeNotice()"
      @focusin="batch.pauseNotice()"
      @focusout="batch.resumeNotice()"
      data-testid="im-notice"
    >
      <span>{{ batch.notice.value.text }}</span>
      <button v-if="batch.notice.value.undo" type="button" data-testid="im-undo" @click="batch.undo()">{{ t("hide.undo") }}</button>
      <button type="button" class="notice-close" :aria-label="t('hide.dismiss')" @click="batch.dismiss()">×</button>
    </p>
  </main>
  <AgentManagementOverlay v-if="session && canManageAgents && managementOpen" :key="session.uid"
    :label="definitionText('title', getLocale())" @close="managementOpen = false">
    <template #default="{ close }">
      <div class="agent-management-page">
        <AgentManagement :api="agentDefinitions" closable
          @close="close" @invalidated="refreshAgentPresentation()" />
      </div>
    </template>
  </AgentManagementOverlay>
</template>

<style scoped>
.agent-management-page {
  height: 100vh;
  height: 100dvh;
  min-width: 0;
  overflow-y: auto;
}
.agent-effective-panel { padding: 0 16px; max-height: 45dvh; overflow-y: auto; min-height: 0; flex-shrink: 0; }
</style>

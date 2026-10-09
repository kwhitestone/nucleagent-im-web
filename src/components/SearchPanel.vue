<script setup lang="ts">
// IM3-D5 (Q3 §5): the search page. Replaces the conversation list while open (desktop) and
// covers the screen on phones. Conversations and agents match locally on titles; people come
// from the auth directory (2+ characters); messages and files from im search (2–64). One
// character is local-only: im refuses it (an ngram token is two characters).
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { ChannelTypeGroup, ChannelTypePerson, type Conversation } from "wukongimjssdk";
import { searchDirectory, type ConnectSession, type DirectoryEntry } from "../api";
import { matchAgents, type DirectoryAgent } from "../agents";
import { nameFor } from "../names";
import {
  clearRecentSearches,
  countLabel,
  loadRecentSearches,
  markSegments,
  messageSearch,
  queryMode,
  rememberSearch,
  titleMatch,
  type MessageHit,
  type Range,
} from "../search";
import type { ProfileTarget } from "../accountPopover";
import RowAvatar from "./RowAvatar.vue";

type Tab = "all" | "conversations" | "contacts" | "agents" | "messages" | "files";
type Group = Exclude<Tab, "all">;
const tabs: Tab[] = ["all", "conversations", "contacts", "agents", "messages", "files"];

const props = defineProps<{
  session: ConnectSession;
  /** Visible and hidden conversations; hidden ones carry the 已隐藏 tag. */
  conversations: Conversation[];
  hiddenKeys: Set<string>;
  agents: DirectoryAgent[];
  titleFor: (conversation: Conversation) => string;
}>();
const emit = defineEmits<{
  close: [];
  conversation: [conversation: Conversation];
  contact: [entry: DirectoryEntry];
  agent: [agent: DirectoryAgent];
  message: [hit: MessageHit];
  /** Contact ⓘ: that person's card, whose primary action opens the chat (same as the old picker). */
  profile: [anchor: HTMLElement, target: ProfileTarget];
}>();
const { t } = useI18n();

const input = ref<HTMLInputElement>();
const query = ref("");
const tab = ref<Tab>("all");
const active = ref(0);
const recent = ref(loadRecentSearches(props.session.uid));
const loading = ref(false);
const error = ref("");
const people = ref<DirectoryEntry[]>([]);
const messages = ref<MessageHit[]>([]);
const files = ref<MessageHit[]>([]);
const totals = ref({ messages: 0, files: 0 });
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

const mode = computed(() => queryMode(query.value));
const keyOf = (c: Conversation) => `${c.channel.channelType}:${c.channel.channelID}`;
const agentUids = computed(() => new Set(props.agents.map((agent) => String(agent.uid))));

const conversationHits = computed(() => mode.value === "idle" ? [] : props.conversations
  .map((conversation) => {
    const title = props.titleFor(conversation);
    return { conversation, title, ranges: titleMatch(title, query.value) || [] };
  })
  .filter((row) => row.ranges.length));
const agentHits = computed(() => (mode.value === "full" ? matchAgents(props.agents, query.value, (uid) => nameFor(uid)) : [])
  .map((agent) => ({ agent, title: nameFor(String(agent.uid)) || agent.name })));
// One character: the directory is not asked (it needs 2); people = direct chats whose name matches.
const peopleHits = computed(() => mode.value === "single"
  ? conversationHits.value
    .filter((row) => row.conversation.channel.channelType === ChannelTypePerson && !agentUids.value.has(row.conversation.channel.channelID))
    .map((row) => ({ entry: { id: Number(row.conversation.channel.channelID), username: "", displayName: row.title, accountType: "human", provisioned: true } as DirectoryEntry, title: row.title }))
  : people.value
    .filter((entry) => !agentUids.value.has(String(entry.id)))
    .map((entry) => ({ entry, title: nameFor(String(entry.id), entry.displayName, entry.username) || entry.displayName })));

const counts = computed<Record<Tab, number>>(() => ({
  all: 0,
  conversations: conversationHits.value.length,
  contacts: peopleHits.value.length,
  agents: agentHits.value.length,
  messages: totals.value.messages,
  files: totals.value.files,
}));

type Row =
  | { kind: "conversation"; key: string; conversation: Conversation; title: string; ranges: Range[] }
  | { kind: "contact"; key: string; entry: DirectoryEntry; title: string }
  | { kind: "agent"; key: string; agent: DirectoryAgent; title: string }
  | { kind: "message"; key: string; hit: MessageHit };

const groups = computed(() => {
  const all: Record<Group, Row[]> = {
    conversations: conversationHits.value.map((r) => ({ kind: "conversation" as const, key: `c:${keyOf(r.conversation)}`, ...r })),
    contacts: peopleHits.value.map((r) => ({ kind: "contact" as const, key: `p:${r.entry.id}:${r.entry.openId ?? ""}`, ...r })),
    agents: agentHits.value.map((r) => ({ kind: "agent" as const, key: `a:${r.agent.uid}`, ...r })),
    messages: messages.value.map((hit) => ({ kind: "message" as const, key: `m:${hit.id}`, hit })),
    files: files.value.map((hit) => ({ kind: "message" as const, key: `f:${hit.id}`, hit })),
  };
  const shown: Group[] = tab.value === "all" ? ["conversations", "contacts", "agents", "messages", "files"] : [tab.value];
  return shown
    .map((name) => ({ name, rows: tab.value === "all" ? all[name].slice(0, 3) : all[name], more: tab.value === "all" && all[name].length > 3 }))
    .filter((group) => group.rows.length);
});
const flat = computed(() => groups.value.flatMap((group) => group.rows));
const hasResults = computed(() => flat.value.length > 0);

watch(query, () => {
  clearTimeout(timer);
  active.value = 0;
  error.value = "";
  generation += 1;
  people.value = [];
  messages.value = [];
  files.value = [];
  totals.value = { messages: 0, files: 0 };
  loading.value = mode.value === "full";
  if (mode.value === "full") timer = setTimeout(() => void search(), 250);
});
watch(tab, () => { active.value = 0; });

async function search(): Promise<void> {
  const mine = ++generation;
  const q = query.value;
  loading.value = true;
  error.value = "";
  try {
    if (mode.value === "full") {
      const [dir, msg, file] = await Promise.all([
        searchDirectory(q, props.session).catch(() => ({ items: [] as DirectoryEntry[] })),
        messageSearch(q, "message", props.session),
        messageSearch(q, "file", props.session),
      ]);
      if (mine !== generation) return;
      people.value = dir.items;
      messages.value = msg.hits;
      files.value = file.hits;
      totals.value = { messages: msg.total, files: file.total };
      rememberSearch(props.session.uid, q);
      recent.value = loadRecentSearches(props.session.uid);
    }
  } catch (cause) {
    if (mine === generation) error.value = cause instanceof Error ? cause.message : t("search.errFailed");
  } finally {
    if (mine === generation) loading.value = false;
  }
}

function retry(): void {
  void search();
}

function pick(row: Row): void {
  if (query.value.trim()) {
    rememberSearch(props.session.uid, query.value);
    recent.value = loadRecentSearches(props.session.uid);
  }
  if (row.kind === "conversation") emit("conversation", row.conversation);
  else if (row.kind === "contact") emit("contact", row.entry);
  else if (row.kind === "agent") emit("agent", row.agent);
  else emit("message", row.hit);
}

function inspect(entry: DirectoryEntry, title: string, anchor: HTMLElement): void {
  emit("profile", anchor, {
    uid: entry.provisioned ? String(entry.id) : "",
    openId: entry.openId || undefined,
    portalUid: entry.provisioned || entry.openId ? undefined : entry.portalUid,
    known: { nickName: title, username: entry.username, avatar: entry.avatar, accountType: entry.accountType, provisioned: entry.provisioned },
    select: () => emit("contact", entry),
  });
}

function useRecent(q: string): void {
  query.value = q;
  input.value?.focus();
}

function clearRecent(): void {
  clearRecentSearches(props.session.uid);
  recent.value = [];
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === "Tab") {
    event.preventDefault();
    const at = tabs.indexOf(tab.value) + (event.shiftKey ? -1 : 1);
    tab.value = tabs[(at + tabs.length) % tabs.length];
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    active.value = Math.min(active.value + 1, Math.max(flat.value.length - 1, 0));
    scrollActive();
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    active.value = Math.max(active.value - 1, 0);
    scrollActive();
  } else if (event.key === "Enter") {
    const row = flat.value[active.value];
    if (row) {
      event.preventDefault();
      pick(row);
    }
  } else if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    if (query.value) query.value = "";
    else emit("close");
  }
}

function scrollActive(): void {
  void nextTick(() => document.querySelector(".search-panel .search-row.active")?.scrollIntoView({ block: "nearest" }));
}

function rowIndex(row: Row): number {
  return flat.value.indexOf(row);
}

function time(seconds: number): string {
  return seconds ? new Date(seconds * 1000).toLocaleDateString([], { month: "numeric", day: "numeric" }) : "";
}

function hitTitle(hit: MessageHit): string {
  const conversation = props.conversations.find((c) => c.channel.isEqual(hit.channel));
  if (conversation) return props.titleFor(conversation);
  return hit.channel.channelType === ChannelTypeGroup ? t("chat.groupChat") : nameFor(hit.channel.channelID);
}

function avatarKind(conversation: Conversation): "group" | "agent" | "person" {
  if (conversation.channel.channelType === ChannelTypeGroup) return "group";
  return agentUids.value.has(conversation.channel.channelID) ? "agent" : "person";
}

onMounted(() => input.value?.focus());
onBeforeUnmount(() => clearTimeout(timer));
defineExpose({ focus: () => input.value?.focus() });
</script>

<template>
  <section class="search-panel" data-testid="im-search-panel" :aria-label="t('tab.search')">
    <header class="search-head">
      <button class="icon-button search-back" type="button" data-testid="im-search-close" :aria-label="t('search.close')" @click="emit('close')">‹</button>
      <input
        ref="input"
        v-model="query"
        class="search-input"
        type="search"
        data-testid="im-search-input"
        :placeholder="t('search.panelPlaceholder')"
        :aria-label="t('search.panelPlaceholder')"
        autocomplete="off"
        enterkeyhint="search"
        @keydown="onKeydown"
      >
    </header>
    <div class="search-tabs" role="tablist" :aria-label="t('tab.search')">
      <button
        v-for="name in tabs"
        :key="name"
        type="button"
        role="tab"
        class="search-tab"
        :class="{ active: tab === name }"
        :aria-selected="tab === name"
        :data-testid="`im-search-tab-${name}`"
        @click="tab = name"
      >
        {{ t(`search.tabs.${name}`) }}<span v-if="name !== 'all' && mode !== 'idle'" class="search-count">{{ countLabel(counts[name]) }}</span>
      </button>
    </div>

    <div class="search-results" role="listbox">
      <!-- Idle: recent searches (this account, this browser). -->
      <template v-if="mode === 'idle'">
        <div v-if="recent.length" data-testid="im-search-recent">
          <p class="search-section">
            <span>{{ t("search.recent") }}</span>
            <button class="quiet" type="button" data-testid="im-search-clear-recent" @click="clearRecent">{{ t("search.clearRecent") }}</button>
          </p>
          <button v-for="item in recent" :key="item" class="search-recent" type="button" @click="useRecent(item)">{{ item }}</button>
        </div>
        <p v-else class="search-status" data-testid="im-search-idle">{{ t("search.idleHint") }}</p>
      </template>

      <template v-else>
        <p v-if="mode === 'single'" class="search-status" data-testid="im-search-single">{{ t("search.singleChar") }}</p>
        <p v-else-if="mode === 'tooLong'" class="search-status">{{ t("search.tooLong") }}</p>
        <div v-if="error" class="search-status error" role="alert" data-testid="im-search-error">
          <span>{{ t("search.errFailed") }}</span>
          <button class="quiet" type="button" data-testid="im-search-retry" @click="retry">{{ t("search.retry") }}</button>
        </div>

        <section v-for="group in groups" :key="group.name" class="search-group" :data-testid="`im-search-group-${group.name}`">
          <p class="search-section">
            <span>{{ t(`search.tabs.${group.name}`) }}</span>
            <button v-if="group.more" class="quiet" type="button" @click="tab = group.name">{{ t("search.seeAll") }} ›</button>
          </p>
          <div v-for="row in group.rows" :key="row.key" class="search-row-wrap">
          <button
            type="button"
            role="option"
            class="search-row"
            :class="{ active: rowIndex(row) === active }"
            :aria-selected="rowIndex(row) === active"
            :data-testid="`im-search-row-${row.kind}`"
            @mouseenter="active = rowIndex(row)"
            @click="pick(row)"
          >
            <template v-if="row.kind === 'conversation'">
              <RowAvatar :id="row.conversation.channel.channelID" :name="row.title" :kind="avatarKind(row.conversation)" />
              <span class="search-copy">
                <strong><template v-for="(segment, i) in markSegments(row.title, row.ranges)" :key="i"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></strong>
                <small>{{ row.conversation.channel.channelType === ChannelTypeGroup ? t("chat.groupChat") : t("chat.directMessage") }}</small>
              </span>
              <span v-if="hiddenKeys.has(keyOf(row.conversation))" class="account-badge hidden-tag">{{ t("hide.tag") }}</span>
            </template>
            <template v-else-if="row.kind === 'contact'">
              <RowAvatar :id="String(row.entry.id)" :name="row.title" kind="person" />
              <span class="search-copy">
                <strong><template v-for="(segment, i) in markSegments(row.title, titleMatch(row.title, query) || [])" :key="i"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></strong>
                <small v-if="row.entry.username">@{{ row.entry.username }}</small>
              </span>
              <span v-if="hiddenKeys.has(`${ChannelTypePerson}:${row.entry.id}`)" class="account-badge hidden-tag">{{ t("hide.tag") }}</span>
              <span class="account-badge person">{{ t("badge.person") }}</span>
            </template>
            <template v-else-if="row.kind === 'agent'">
              <RowAvatar :id="String(row.agent.uid)" :name="row.title" kind="agent" />
              <span class="search-copy">
                <strong><template v-for="(segment, i) in markSegments(row.title, titleMatch(row.title, query) || [])" :key="i"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template></strong>
                <small v-if="row.agent.description">{{ row.agent.description }}</small>
              </span>
              <span class="account-badge agent">{{ t("badge.agent") }}</span>
            </template>
            <template v-else>
              <RowAvatar :id="row.hit.channel.channelID" :name="hitTitle(row.hit)" :kind="row.hit.channel.channelType === ChannelTypeGroup ? 'group' : 'person'" />
              <span class="search-copy">
                <strong>{{ hitTitle(row.hit) }}</strong>
                <small>
                  <span v-if="row.hit.channel.channelType === ChannelTypeGroup">{{ nameFor(row.hit.fromUid) }} · </span>
                  <template v-for="(segment, i) in markSegments(row.hit.snippet, row.hit.ranges)" :key="i"><mark v-if="segment.hit">{{ segment.text }}</mark><template v-else>{{ segment.text }}</template></template>
                </small>
              </span>
              <span class="search-end">
                <span class="conversation-time">{{ time(row.hit.timestamp) }}</span>
                <span v-if="row.hit.hidden" class="account-badge hidden-tag">{{ t("hide.tag") }}</span>
              </span>
            </template>
          </button>
          <button
            v-if="row.kind === 'contact'"
            class="contact-info"
            type="button"
            data-testid="im-search-info"
            :aria-label="t('profile.view', { name: row.title })"
            @click="inspect(row.entry, row.title, $event.currentTarget as HTMLElement)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
          </button>
          </div>
        </section>

        <!-- Local title hits show at once; the skeleton stands for the remote groups still loading. -->
        <div v-if="loading" class="search-skeleton" data-testid="im-search-skeleton" aria-busy="true">
          <span v-for="n in 4" :key="n" class="skeleton-row"><i /><b /></span>
        </div>
        <div v-else-if="!loading && !error && !hasResults" class="search-status" data-testid="im-search-empty">
          <strong>{{ t("search.empty", { query: query.trim() }) }}</strong>
          <p>{{ t("search.emptyRules") }}</p>
        </div>
      </template>
    </div>
  </section>
</template>

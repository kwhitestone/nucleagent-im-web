<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  browseDirectory,
  minContactQueryLength,
  phoneDigits,
  provisionContact,
  searchDirectory,
  type ConnectSession,
  type Contact,
  type DirectoryEntry,
} from "../api";
import { ensureNames, handleFor, isEnterprise, nameFor } from "../names";
import { matchAgents, type DirectoryAgent } from "../agents";
import type { ProfileTarget } from "../accountPopover";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  session: ConnectSession;
  modelValue?: Contact[];
  multiple?: boolean;
  excludeUids?: number[];
  label?: string;
  placeholder?: string;
  /** UNI-IM-REDESIGN: when given, matching agents get their own section above people. */
  agents?: DirectoryAgent[];
}>(), {
  modelValue: () => [],
  multiple: false,
  excludeUids: () => [],
  label: "",
  placeholder: "",
  agents: () => [],
});

const emit = defineEmits<{
  select: [contact: Contact];
  "update:modelValue": [contacts: Contact[]];
  /** ⓘ: show this person's profile card; its primary action picks them (board §04). */
  profile: [anchor: HTMLElement, target: ProfileTarget];
  agent: [agent: DirectoryAgent];
}>();

const query = ref("");
const results = ref<DirectoryEntry[]>([]);
const loading = ref(false);
const error = ref("");
const page = ref(1);
const hasMore = ref(false);
const degraded = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

watch(query, (value) => {
  if (timer) clearTimeout(timer);
  error.value = "";
  if (value.trim().length < minContactQueryLength) {
    generation += 1;
    results.value = [];
    loading.value = false;
    return;
  }
  const current = ++generation;
  loading.value = true;
  timer = setTimeout(async () => {
    try {
      const found = await searchDirectory(value, props.session);
      if (current !== generation) return;
      page.value = 1;
      hasMore.value = found.hasMore;
      degraded.value = found.degraded;
      results.value = visible(found.items);
    } catch (cause) {
      if (current === generation) {
        error.value = cause instanceof Error ? cause.message : t("search.errFailed");
        results.value = [];
      }
    } finally {
      if (current === generation) loading.value = false;
    }
  }, 250);
});

// Agents match on name or description (contains, not prefix): users remember
// what an agent does more often than its exact name. Shown once, so the same
// uid is dropped from the people rows below.
const agentMatches = computed(() => matchAgents(props.agents, query.value, (uid) => nameFor(uid)));
const peopleResults = computed(() => {
  const agentUids = new Set(agentMatches.value.map((agent) => agent.uid));
  return results.value.filter((item) => !agentUids.has(item.id));
});

function chooseAgent(agent: DirectoryAgent): void {
  emit("agent", agent);
  query.value = "";
  results.value = [];
  open.value = false;
}

function visible(items: DirectoryEntry[]): DirectoryEntry[] {
  const excluded = new Set([...props.excludeUids, ...props.modelValue.map((contact) => contact.id)]);
  return items.filter((item) => !item.id || !excluded.has(item.id));
}

async function more(): Promise<void> {
  const current = generation;
  loading.value = true;
  try {
    const found = await searchDirectory(query.value, props.session, page.value + 1);
    if (current !== generation) return;
    page.value = found.page;
    hasMore.value = found.hasMore;
    results.value = [...results.value, ...visible(found.items)];
  } catch (cause) {
    if (current === generation) error.value = cause instanceof Error ? cause.message : t("search.errFailed");
  } finally {
    if (current === generation) loading.value = false;
  }
}

// Browse: with an empty query, focusing the box lists everyone by name
// (keyset-paged by the server). Loaded once per picker and kept, so reopening
// is instant; exclusions are applied at render so picks drop out live.
const root = ref<HTMLElement | null>(null);
const open = ref(false);
const browseItems = ref<DirectoryEntry[]>([]);
const browseCursor = ref("");
const browseHasMore = ref(false);
const browseLoaded = ref(false);
const browseOff = ref(false); // directory switched off: search-only picker
const browseDegraded = ref(false);
const browseLoading = ref(false);
const browseError = ref("");
const browsing = computed(() => open.value && !query.value.trim() && !browseOff.value);
const browseShown = computed(() => visible(browseItems.value));

async function loadBrowse(): Promise<void> {
  if (browseLoading.value) return;
  browseLoading.value = true;
  browseError.value = "";
  try {
    const found = await browseDirectory(props.session, browseCursor.value);
    if (!found) {
      browseOff.value = true;
      return;
    }
    browseItems.value = [...browseItems.value, ...found.items];
    browseCursor.value = found.nextCursor ?? "";
    browseHasMore.value = found.hasMore && !!found.nextCursor;
    browseDegraded.value = found.degraded;
    browseLoaded.value = true;
  } catch (cause) {
    browseError.value = cause instanceof Error ? cause.message : t("search.errFailed");
  } finally {
    browseLoading.value = false;
  }
}

function openBrowse(): void {
  open.value = true;
  if (!browseLoaded.value && !browseOff.value) void loadBrowse();
}

function closeOnOutside(event: PointerEvent): void {
  if (root.value && !root.value.contains(event.target as Node)) open.value = false;
}
if (typeof document !== "undefined") document.addEventListener("pointerdown", closeOnOutside);

// Provisioned rows go through the same resolver as the conversation list, so a
// directory-provisioned person who never logged in reads by their portal name
// here too, not auth's stored "Portal user N".
watch(() => [...results.value, ...browseItems.value], (items) => {
  void ensureNames(items.filter((item) => item.id).map((item) => String(item.id)), props.session);
});

// Directory rows always carry a name (the server's own "Portal user N" floor
// included), so the last resort is that stored name — never a UID.
function rowName(contact: Contact): string {
  return nameFor(String(contact.id), contact.displayName, contact.username)
    || contact.displayName || contact.username;
}

// Board §04: the least needed to tell same-named people apart — the real
// @username (resolved; never portal_<uuid>), else "Enterprise"; then the UID.
function rowSub(contact: DirectoryEntry): string {
  const uid = String(contact.id);
  const handle = handleFor(uid, contact.username);
  const lead = handle ? `@${handle}` : isEnterprise(uid) ? t("badge.enterprise") : "";
  return [lead, `${t("badge.uid")} ${uid}`, contact.phoneMasked].filter(Boolean).join(" · ");
}

/** Portal-only rows: enterprise, the masked phone when there is one, then not joined. */
function portalSub(contact: DirectoryEntry): string {
  return [t("badge.enterprise"), contact.phoneMasked, t("badge.notJoined")].filter(Boolean).join(" · ");
}

// Digits typed (a phone number): ask phones for the phone keypad.
// ponytail: iOS applies a changed inputmode only on the next focus; a
// separate phone field would fix that if users ask.
const inputMode = computed(() => (/^\s*\+?\d/.test(query.value) ? "tel" : "search"));
const phoneSearch = computed(() => !!phoneDigits(query.value));

function entryKey(entry: DirectoryEntry): string {
  return entry.openId || `${entry.id}:${entry.portalUid ?? 0}`;
}

// Portal-only people get their local account (and IM uid) on first pick;
// whatever is sent waits in WuKongIM until they first log in.
async function choose(entry: DirectoryEntry): Promise<void> {
  let contact: Contact;
  try {
    contact = await provisionContact(entry, props.session);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("search.errFailed");
    return;
  }
  if (props.multiple) {
    emit("update:modelValue", [...props.modelValue, contact]);
  } else {
    emit("select", contact);
  }
  query.value = "";
  results.value = [];
  if (!props.multiple) open.value = false; // group dialog: keep browsing to add more
}

function inspect(entry: DirectoryEntry, anchor: HTMLElement): void {
  emit("profile", anchor, {
    uid: entry.provisioned ? String(entry.id) : "",
    openId: entry.openId || undefined,
    portalUid: entry.provisioned || entry.openId ? undefined : entry.portalUid,
    known: {
      nickName: rowName(entry), username: entry.username, avatar: entry.avatar,
      accountType: entry.accountType, provisioned: entry.provisioned,
    },
    select: () => void choose(entry),
  });
}

function remove(contact: Contact): void {
  emit("update:modelValue", props.modelValue.filter((item) => item.id !== contact.id));
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  if (typeof document !== "undefined") document.removeEventListener("pointerdown", closeOnOutside);
});
</script>

<template>
  <div ref="root" class="contact-picker">
    <label v-if="label" class="field-label">{{ label }}</label>
    <input
      v-model="query"
      class="contact-search"
      type="search"
      :inputmode="inputMode"
      :aria-label="label || placeholder || t('search.placeholder')"
      :placeholder="placeholder || t('search.placeholder')"
      :aria-expanded="browsing"
      autocomplete="off"
      @focus="openBrowse"
      @click="openBrowse"
      @keydown.esc="open = false"
    >
    <div v-if="multiple && modelValue.length" class="selected-contacts">
      <button
        v-for="contact in modelValue"
        :key="contact.id"
        class="selection"
        type="button"
        :aria-label="t('group.remove') + ' ' + rowName(contact)"
        @click="remove(contact)"
      >
        {{ rowName(contact) }} <span aria-hidden="true">×</span>
      </button>
    </div>
    <!-- Agents first (UNI-IM-REDESIGN). Browsing means an empty query, so never both. -->
    <div v-if="agentMatches.length" class="contact-results" role="listbox" data-testid="im-search-agents">
      <p class="picker-section">{{ t("search.agentsSection") }}</p>
      <div v-for="agent in agentMatches" :key="agent.uid" class="contact-row">
        <button class="contact-result" type="button" role="option" @click="chooseAgent(agent)">
          <span>
            <strong>{{ nameFor(String(agent.uid)) || agent.name }}</strong>
            <small v-if="agent.description">{{ agent.description }}</small>
          </span>
          <span class="account-badge agent">{{ t("badge.agent") }}</span>
        </button>
      </div>
      <p v-if="peopleResults.length" class="picker-section">{{ t("search.peopleSection") }}</p>
    </div>
    <!-- Browse mode: everyone, by name. Same rows and badges as search. -->
    <div v-if="browsing" class="contact-results" role="listbox" data-testid="im-directory-browse">
      <div v-for="contact in browseShown" :key="entryKey(contact)" class="contact-row">
        <button class="contact-result" type="button" role="option" @click="choose(contact)">
          <span>
            <strong>{{ rowName(contact) }}</strong>
            <small v-if="contact.provisioned">{{ rowSub(contact) }}</small>
            <small v-else>{{ portalSub(contact) }}</small>
          </span>
          <span class="account-badge" :class="contact.provisioned ? contact.accountType : 'portal'">
            {{ contact.accountType === "agent" ? t("badge.agent") : t("badge.person") }}
          </span>
        </button>
        <button
          class="contact-info"
          type="button"
          data-testid="im-picker-info"
          :aria-label="t('profile.view', { name: rowName(contact) })"
          @click="inspect(contact, $event.currentTarget as HTMLElement)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
        </button>
      </div>
      <p v-if="error" class="picker-status error" role="alert">{{ error }}</p>
      <p v-if="browseLoading" class="picker-status">{{ t("chat.loading") }}</p>
      <p v-else-if="browseError" class="picker-status error" role="alert">{{ browseError }}</p>
      <button v-else-if="browseHasMore" class="quiet contact-more" type="button" @click="loadBrowse">{{ t("search.loadMore") }}</button>
      <p v-else-if="browseLoaded && !browseShown.length" class="picker-status">{{ t("search.browseEmpty") }}</p>
      <p v-else-if="browseLoaded" class="picker-status picker-end">{{ t("search.browseEnd") }}</p>
      <p v-if="browseDegraded" class="picker-status">{{ t("search.degraded") }}</p>
    </div>
    <p v-else-if="query.trim().length === 1" class="picker-status">{{ t("search.minChars") }}</p>
    <p v-else-if="loading" class="picker-status">{{ t("search.searching") }}</p>
    <p v-else-if="error" class="picker-status error" role="alert">{{ error }}</p>
    <div v-else-if="peopleResults.length" class="contact-results" role="listbox">
      <div v-for="contact in peopleResults" :key="entryKey(contact)" class="contact-row">
        <button class="contact-result" type="button" role="option" @click="choose(contact)">
          <span>
            <strong>{{ rowName(contact) }}</strong>
            <!-- UID stays as secondary text: the only way to tell duplicate names
                 apart, and it quietly teaches that a UID is shareable. -->
            <small v-if="contact.provisioned">{{ rowSub(contact) }}</small>
            <small v-else>{{ portalSub(contact) }}</small>
          </span>
          <span class="account-badge" :class="contact.provisioned ? contact.accountType : 'portal'">
            {{ contact.accountType === "agent" ? t("badge.agent") : t("badge.person") }}
          </span>
        </button>
        <button
          class="contact-info"
          type="button"
          data-testid="im-picker-info"
          :aria-label="t('profile.view', { name: rowName(contact) })"
          @click="inspect(contact, $event.currentTarget as HTMLElement)"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>
        </button>
      </div>
      <button v-if="hasMore" class="quiet contact-more" type="button" @click="more">{{ t("search.more") }}</button>
      <p v-if="degraded" class="picker-status">{{ t("search.degraded") }}</p>
    </div>
    <!-- Previously nothing rendered here at all, so a search that matched
         nothing looked identical to one still in flight. The copy states that
         matching is prefix-only: searching mid-string silently returns nobody
         and otherwise reads as "this person does not exist". -->
    <div v-else-if="query.trim().length >= minContactQueryLength && !agentMatches.length" class="picker-empty">
      <p>{{ t("search.noResults", { query: query.trim() }) }}</p>
      <small>{{ t(phoneSearch ? "search.phoneHint" : "search.prefixHint") }}</small>
    </div>
  </div>
</template>

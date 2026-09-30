<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  browseDirectory,
  minContactQueryLength,
  provisionContact,
  searchDirectory,
  type ConnectSession,
  type Contact,
  type DirectoryEntry,
} from "../api";
import { ensureNames, isRealName, nameFor } from "../names";

const { t } = useI18n();

const props = withDefaults(defineProps<{
  session: ConnectSession;
  modelValue?: Contact[];
  multiple?: boolean;
  excludeUids?: number[];
  label?: string;
  placeholder?: string;
}>(), {
  modelValue: () => [],
  multiple: false,
  excludeUids: () => [],
  label: "",
  placeholder: "",
});

const emit = defineEmits<{
  select: [contact: Contact];
  "update:modelValue": [contacts: Contact[]];
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

// A portal account's username is a random portal_<uuid>: not worth a line.
function rowSub(contact: Contact): string {
  const uid = `${t("badge.uid")} ${contact.id}`;
  return isRealName(contact.username) ? `@${contact.username} · ${uid}` : uid;
}

function entryKey(entry: DirectoryEntry): string {
  return `${entry.id}:${entry.portalUid ?? 0}`;
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
    <!-- Browse mode: everyone, by name. Same rows and badges as search. -->
    <div v-if="browsing" class="contact-results" role="listbox" data-testid="im-directory-browse">
      <button
        v-for="contact in browseShown"
        :key="entryKey(contact)"
        class="contact-result"
        type="button"
        role="option"
        @click="choose(contact)"
      >
        <span>
          <strong>{{ rowName(contact) }}</strong>
          <small v-if="contact.provisioned">{{ rowSub(contact) }}</small>
          <small v-else>{{ t("badge.notJoined") }}</small>
        </span>
        <span class="account-badge" :class="contact.provisioned ? contact.accountType : 'portal'">
          {{ contact.accountType === "agent" ? t("badge.agent") : t("badge.person") }}
        </span>
      </button>
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
    <div v-else-if="results.length" class="contact-results" role="listbox">
      <button
        v-for="contact in results"
        :key="entryKey(contact)"
        class="contact-result"
        type="button"
        role="option"
        @click="choose(contact)"
      >
        <span>
          <strong>{{ rowName(contact) }}</strong>
          <!-- UID stays as secondary text: the only way to tell duplicate names
               apart, and it quietly teaches that a UID is shareable. -->
          <small v-if="contact.provisioned">{{ rowSub(contact) }}</small>
          <small v-else>{{ t("badge.notJoined") }}</small>
        </span>
        <span class="account-badge" :class="contact.provisioned ? contact.accountType : 'portal'">
          {{ contact.accountType === "agent" ? t("badge.agent") : t("badge.person") }}
        </span>
      </button>
      <button v-if="hasMore" class="quiet contact-more" type="button" @click="more">{{ t("search.more") }}</button>
      <p v-if="degraded" class="picker-status">{{ t("search.degraded") }}</p>
    </div>
    <!-- Previously nothing rendered here at all, so a search that matched
         nothing looked identical to one still in flight. The copy states that
         matching is prefix-only: searching mid-string silently returns nobody
         and otherwise reads as "this person does not exist". -->
    <div v-else-if="query.trim().length >= minContactQueryLength" class="picker-empty">
      <p>{{ t("search.noResults", { query: query.trim() }) }}</p>
      <small>{{ t("search.prefixHint") }}</small>
    </div>
  </div>
</template>

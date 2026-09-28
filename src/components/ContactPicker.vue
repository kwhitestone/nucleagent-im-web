<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import {
  minContactQueryLength,
  provisionContact,
  searchDirectory,
  type ConnectSession,
  type Contact,
  type DirectoryEntry,
} from "../api";

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
}

function remove(contact: Contact): void {
  emit("update:modelValue", props.modelValue.filter((item) => item.id !== contact.id));
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});
</script>

<template>
  <div class="contact-picker">
    <label v-if="label" class="field-label">{{ label }}</label>
    <input
      v-model="query"
      class="contact-search"
      type="search"
      :aria-label="label || placeholder || t('search.placeholder')"
      :placeholder="placeholder || t('search.placeholder')"
      autocomplete="off"
    >
    <div v-if="multiple && modelValue.length" class="selected-contacts">
      <button
        v-for="contact in modelValue"
        :key="contact.id"
        class="selection"
        type="button"
        :aria-label="t('group.remove') + ' ' + (contact.displayName || contact.username)"
        @click="remove(contact)"
      >
        {{ contact.displayName || contact.username }} <span aria-hidden="true">×</span>
      </button>
    </div>
    <p v-if="query.trim().length === 1" class="picker-status">{{ t("search.minChars") }}</p>
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
          <strong>{{ contact.displayName || contact.username }}</strong>
          <!-- Both @username and UID: the only way to tell duplicate names
               apart, and it quietly teaches that a UID is shareable. -->
          <small v-if="contact.provisioned">@{{ contact.username }} · {{ t("badge.uid") }} {{ contact.id }}</small>
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

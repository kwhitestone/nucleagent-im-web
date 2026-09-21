<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from "vue";
import {
  minContactQueryLength,
  searchContacts,
  type ConnectSession,
  type Contact,
} from "../api";

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
  placeholder: "Search people and agents",
});

const emit = defineEmits<{
  select: [contact: Contact];
  "update:modelValue": [contacts: Contact[]];
}>();

const query = ref("");
const results = ref<Contact[]>([]);
const loading = ref(false);
const error = ref("");
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
      const contacts = await searchContacts(value, props.session);
      if (current !== generation) return;
      const excluded = new Set([
        ...props.excludeUids,
        ...props.modelValue.map((contact) => contact.id),
      ]);
      results.value = contacts.filter((contact) => !excluded.has(contact.id));
    } catch (cause) {
      if (current === generation) {
        error.value = cause instanceof Error ? cause.message : "Contact search failed";
        results.value = [];
      }
    } finally {
      if (current === generation) loading.value = false;
    }
  }, 250);
});

function choose(contact: Contact): void {
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
      :aria-label="label || placeholder"
      :placeholder="placeholder"
      autocomplete="off"
    >
    <div v-if="multiple && modelValue.length" class="selected-contacts">
      <button
        v-for="contact in modelValue"
        :key="contact.id"
        class="selection"
        type="button"
        :aria-label="`Remove ${contact.displayName || contact.username}`"
        @click="remove(contact)"
      >
        {{ contact.displayName || contact.username }} <span aria-hidden="true">×</span>
      </button>
    </div>
    <p
      v-if="query.trim().length === 1"
      class="picker-status"
    >
      Enter one more character
    </p>
    <p v-else-if="loading" class="picker-status">Searching...</p>
    <p v-else-if="error" class="picker-status error" role="alert">{{ error }}</p>
    <div v-else-if="results.length" class="contact-results" role="listbox">
      <button
        v-for="contact in results"
        :key="contact.id"
        class="contact-result"
        type="button"
        role="option"
        @click="choose(contact)"
      >
        <span>
          <strong>{{ contact.displayName || contact.username }}</strong>
          <small>@{{ contact.username }}</small>
        </span>
        <span class="account-badge" :class="contact.accountType">
          {{ contact.accountType === "agent" ? "Agent" : "Person" }}
        </span>
      </button>
    </div>
  </div>
</template>

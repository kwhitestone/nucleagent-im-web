<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, shallowRef, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Pencil } from "@lucide/vue";
import { ToolBindings as BindingList } from "@prism-fusion/editor-ui";
import { useRemotePage } from "./useRemotePage";
import type { DefinitionApi, ToolOption } from "./api";
import CollectionPager from "./CollectionPager.vue";
import { text } from "./messages";

const props = defineProps<{
  selected: number[]; skillIds: number[]; editable: boolean; manageable: boolean;
  fetchPage: DefinitionApi["toolsPage"];
}>();
const emit = defineEmits<{ toggle: [id: number, checked: boolean]; edit: [id: number] }>();
const { locale } = useI18n();
const selectedOnly = ref(false);
const metadata = shallowRef<ToolOption[]>([]);
const hydrated = ref(false);
const hydrationFailed = ref(false);
let generation = 0;
let controller: AbortController | undefined;
const collection = useRemotePage<ToolOption>((params, signal) => props.fetchPage({
  ...params, ...(selectedOnly.value ? { ids: props.selected.length ? props.selected : [0] } : {}),
}, signal));
const { rows, query, page, total, hasMore, loading, go } = collection;
async function hydrate() {
  const ticket = ++generation;
  controller?.abort();
  controller = new AbortController();
  hydrated.value = false; hydrationFailed.value = false; metadata.value = [];
  if (!props.selected.length) { hydrated.value = true; return; }
  try {
    const result = await props.fetchPage({ page: 1, pageSize: 50, search: "", ids: props.selected }, controller.signal);
    if (ticket !== generation) return;
    metadata.value = result.data; hydrated.value = true;
  } catch { if (ticket === generation) hydrationFailed.value = true; }
}
const visible = computed(() => rows.value.map(row => {
  const translation = row.i18n?.[locale.value] as { name?: unknown } | undefined;
  return { id: row.id, name: typeof translation?.name === "string" ? translation.name : row.name,
    missing: false, covered: !!row.skillIds?.some(id => props.skillIds.includes(id)) };
}));
const unavailable = computed(() => hydrated.value
  ? props.selected.filter(id => !metadata.value.some(row => row.id === id)) : []);
async function refresh() { await Promise.all([collection.load(), hydrate()]); }
watch(selectedOnly, () => { collection.reset(); void collection.load(); });
watch(() => props.selected, () => {
  void hydrate();
  if (selectedOnly.value) void collection.load();
}, { deep: true });
onMounted(refresh);
onScopeDispose(() => { generation++; controller?.abort(); });
defineExpose({ refresh });
</script>

<template>
  <BindingList :rows="visible" :selected="selected" :unavailable="unavailable" :editable="editable"
    :manageable="manageable" v-model:query="query" v-model:selected-only="selectedOnly"
    :search-label="text('searchTools', locale)" :selected-label="text('selectedTools', locale)"
    :edit-label="text('edit', locale)" :covered-label="text('toolCovered', locale)" :unavailable-label="text('toolUnavailable', locale)"
    @toggle="(id, checked) => editable && emit('toggle', id, checked)" @edit="manageable && emit('edit', $event)">
    <template #edit-icon><Pencil :size="16" /></template>
    <template #pager><CollectionPager :page="page" :total="total" :has-more="hasMore" :loading="loading"
      :failed="collection.failed.value || hydrationFailed" @page="go" @retry="refresh" /></template>
  </BindingList>
</template>

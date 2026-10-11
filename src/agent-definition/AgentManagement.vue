<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, RefreshCw, Search, ChevronRight, Bot, Plus } from "@lucide/vue";
import DefinitionDrawer from "./DefinitionDrawer.vue";
import CreateDefinition from "./CreateDefinition.vue";
import { DefinitionError, type Catalog, type Definition, type DefinitionApi, type Detail } from "./api";
import { invalidatedDefinitions } from "./events";
import { newerRevision, readPath } from "./draft";
import { text, type MessageKey } from "./messages";

const props = defineProps<{ api: DefinitionApi; initialId?: number; closable?: boolean }>();
const emit = defineEmits<{ close: []; invalidated: [ids: number[]] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const definitions = ref<Definition[]>([]);
const selected = ref<Detail | null>(null);
const catalog = ref<Catalog>();
const creating = ref(false);
const loading = ref(false);
const error = ref<MessageKey | "">("");
const query = ref("");
const filter = ref("all");
const failedAvatars = ref(new Set<string>());
let mounted = true;
let generation = 0;
let selectionGeneration = 0;
let cursor = "0";
let timer: ReturnType<typeof setTimeout> | undefined;
let polling = false;
const state = (definition: Definition): "deleted" | "active" | "disabled" => definition.deletedAt ? "deleted" : definition.isActive ? "active" : "disabled";
const visible = computed(() => definitions.value.filter(definition => (filter.value === "all" || filter.value === state(definition))
  && `${definition.id}\n${definition.name}\n${definition.slug}\n${definition.config?.description ?? ""}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const avatar = (definition: Definition) => {
  const value = definition.config?.avatar;
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; }
};
function failure(cause: unknown) {
  error.value = cause instanceof DefinitionError && [401, 403].includes(cause.status) ? "denied" : "error";
  if (error.value === "denied") {
    generation++; selectionGeneration++;
    definitions.value = []; catalog.value = undefined;
    selected.value = null; creating.value = false; loading.value = false;
  }
}
async function load() {
  const request = ++generation;
  loading.value = true;
  try {
    const [rows, permissions] = await Promise.all([props.api.list(), props.api.catalog()]);
    if (mounted && request === generation) {
      if (!permissions.capabilities.read) throw new DefinitionError(403, "forbidden");
      catalog.value = permissions;
      definitions.value = rows.map(row => {
        const previous = definitions.value.find(item => item.id === row.id);
        return previous && newerRevision(previous.revision, row.revision) ? previous : row;
      });
      error.value = "";
      return true;
    }
  } catch (cause) { if (mounted && request === generation) failure(cause); }
  finally { if (mounted && request === generation) loading.value = false; }
  return false;
}
async function open(id: number) {
  const request = ++selectionGeneration;
  try {
    const record = await props.api.detail(id);
    if (!record.capabilities.read) throw new DefinitionError(403, "forbidden");
    if (mounted && request === selectionGeneration) { selected.value = record; error.value = ""; return true; }
  } catch (cause) { if (mounted && request === selectionGeneration) failure(cause); }
  return false;
}
function closeDetail() { selectionGeneration++; selected.value = null; }
function changed(detail: Detail) {
  selected.value = detail;
  const index = definitions.value.findIndex(row => row.id === detail.definition.id);
  if (index < 0) definitions.value.push(detail.definition);
  else definitions.value[index] = detail.definition;
  emit("invalidated", [detail.definition.id]);
}
function created(detail: Detail) { creating.value = false; changed(detail); }
async function refresh() {
  await load();
  if (selected.value) await open(selected.value.definition.id);
  emit("invalidated", definitions.value.map(row => row.id));
}
async function poll() {
  if (!mounted || polling) return;
  polling = true;
  try {
    if (document.visibilityState !== "hidden") {
      const batch = await props.api.events(cursor);
      if (!mounted) return;
      const result = invalidatedDefinitions(cursor, batch.events, new Map(definitions.value.map(row => [row.id, row.revision])));
      if (!/^\d+$/.test(batch.nextCursor) || newerRevision(result.cursor, batch.nextCursor)) throw new Error("Invalid event cursor");
      if (result.ids.length) {
        if (!await load()) throw new Error("Definition refresh failed");
        if (selected.value && result.ids.includes(selected.value.definition.id) && !await open(selected.value.definition.id)) throw new Error("Detail refresh failed");
        if (mounted) emit("invalidated", result.ids);
      }
      if (newerRevision(batch.nextCursor, cursor)) cursor = batch.nextCursor;
    }
  } catch (cause) { if (mounted && error.value !== "denied") failure(cause); }
  finally {
    polling = false;
    if (mounted) timer = setTimeout(poll, 2000);
  }
}
function onFocus() { if (document.visibilityState !== "hidden") void refresh(); }
onMounted(async () => {
  window.addEventListener("focus", onFocus);
  window.addEventListener("online", onFocus);
  document.addEventListener("visibilitychange", onFocus);
  await load();
  if (mounted && props.initialId) await open(props.initialId);
  if (mounted) void poll();
});
onUnmounted(() => {
  mounted = false; generation++; selectionGeneration++; clearTimeout(timer);
  window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus);
  document.removeEventListener("visibilitychange", onFocus);
});
</script>

<template>
  <section class="agent-management" aria-labelledby="agent-management-title">
    <header class="management-heading">
      <button v-if="closable" type="button" class="icon" :title="label('close')" :aria-label="label('close')" @click="emit('close')"><ArrowLeft :size="20" /></button>
      <h1 id="agent-management-title">{{ label('title') }}</h1>
      <button v-if="catalog?.capabilities.create" type="button" class="icon" :title="label('create')" :aria-label="label('create')" @click="creating = true"><Plus :size="18" /></button>
      <button type="button" class="icon" :title="label('refresh')" :aria-label="label('refresh')" :disabled="loading" @click="refresh"><RefreshCw :size="18" /></button>
    </header>
    <div class="management-toolbar">
      <label class="search"><Search :size="18" aria-hidden="true" /><input v-model="query" type="search" :aria-label="label('search')" :placeholder="label('search')" /></label>
      <select v-model="filter" :aria-label="label('all')"><option v-for="value in (['all', 'active', 'disabled', 'deleted'] as const)" :key="value" :value="value">{{ label(value) }}</option></select>
    </div>
    <p v-if="error" role="alert">{{ label(error) }}</p>
    <p v-if="loading" role="status">{{ label('loading') }}</p>
    <p v-else-if="!visible.length" class="empty">{{ label('empty') }}</p>
    <ul class="agent-rows" :aria-busy="loading">
      <li v-for="definition in visible" :key="definition.id">
        <button type="button" class="agent-row" :data-definition-id="definition.id" @click="open(definition.id)">
          <img v-if="avatar(definition) && !failedAvatars.has(avatar(definition))" :src="avatar(definition)" alt="" class="agent-avatar" referrerpolicy="no-referrer" @error="failedAvatars.add(avatar(definition))" />
          <span v-else class="agent-avatar fallback"><Bot :size="22" /></span>
          <span class="agent-copy"><strong>{{ definition.name }}</strong><small>{{ definition.config?.description }}</small><code>#{{ definition.id }} · {{ definition.slug }}</code></span>
          <span class="model">{{ readPath(definition, '/config/defaults/model') || label('inherit') }}</span>
          <span class="state" :class="state(definition)">{{ label(state(definition)) }}</span>
          <ChevronRight :size="18" aria-hidden="true" />
        </button>
      </li>
    </ul>
    <DefinitionDrawer v-if="selected" :key="selected.definition.id" :api="api" :detail="selected" :catalog="catalog" @close="closeDetail" @changed="changed" />
    <CreateDefinition v-if="creating && catalog" :api="api" :catalog="catalog" @close="creating = false" @created="created" />
  </section>
</template>

<style scoped>
.agent-management { color: var(--text-primary, CanvasText); background: var(--bg-card, Canvas); min-height: 100%; padding: 24px; box-sizing: border-box; }
.management-heading { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; } h1 { font-size: 22px; margin: 0; flex: 1; min-width: 0; overflow-wrap: anywhere; }
button, input, select { font: inherit; color: inherit; } button, select { cursor: pointer; }
.icon, select { display: inline-flex; align-items: center; justify-content: center; min-height: 44px; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-card, Canvas); }
.icon { width: 44px; flex-shrink: 0; } select { padding: 8px 12px; max-width: 100%; }
button:disabled { opacity: .5; cursor: not-allowed; } :focus-visible { outline: 2px solid var(--accent, #16796c); outline-offset: 2px; }
.management-toolbar { display: flex; gap: 12px; margin: 24px 0 12px; flex-wrap: wrap; }
.search { flex: 1; min-width: min(220px, 100%); display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: 4px; }
.search input { min-width: 0; width: 100%; min-height: 44px; border: 0; background: transparent; }
.agent-rows { list-style: none; padding: 0; margin: 0; } .agent-row { width: 100%; display: grid; grid-template-columns: 44px minmax(0, 1fr) minmax(100px, 180px) 80px 20px; gap: 14px; align-items: center; text-align: start; border: 0; border-bottom: 1px solid var(--border); border-radius: 0; background: transparent; padding: 16px 0; cursor: pointer; }
.agent-row:hover { background: var(--bg-hover, #8881); } .agent-copy { min-width: 0; display: grid; gap: 5px; } strong { font-size: 14px; overflow-wrap: anywhere; }
small, code { font-size: 12px; color: var(--text-secondary, GrayText); overflow-wrap: anywhere; } .model { font-size: 12px; overflow-wrap: anywhere; }
.agent-avatar { display: block; width: 44px; height: 44px; border-radius: 6px; object-fit: cover; background: var(--bg-hover, #8881); } .fallback { display: grid; place-items: center; }
.state { font-size: 12px; } .active { color: var(--teal-600, #16806f); } .deleted { color: var(--rose-500, #c13247); }
.empty { padding: 48px 0; text-align: center; color: var(--text-secondary, GrayText); }
@media (max-width: 600px) { .agent-management { padding: 16px; } .agent-row { grid-template-columns: 44px minmax(0, 1fr) 66px 16px; gap: 8px; } .model { display: none; } input, select { font-size: 16px; } h1 { font-size: 20px; } }
</style>

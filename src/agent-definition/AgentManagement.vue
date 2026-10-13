<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { ArrowLeft, RefreshCw, Search, Bot, Plus, Clock, Sparkles } from "@lucide/vue";
import DefinitionDrawer from "./DefinitionDrawer.vue";
import CreateDefinition from "./CreateDefinition.vue";
import { DefinitionError, type Catalog, type Definition, type DefinitionApi, type Detail, type RecommendedRow } from "./api";
import { invalidatedDefinitions } from "./events";
import { newerRevision, readPath } from "./draft";
import { errorKey, text, type MessageKey } from "./messages";
import { avatarGradient, initial } from "./groups";

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
// "all" is every live row; deleted rows only show under the recycle-bin filter.
const visible = computed(() => definitions.value.filter(definition => (filter.value === "all" ? !definition.deletedAt : filter.value === state(definition))
  && `${definition.id}\n${definition.name}\n${definition.slug}\n${definition.config?.description ?? ""}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())));
const avatar = (definition: Definition) => {
  const value = definition.config?.avatar;
  if (typeof value !== "string") return "";
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; }
};
function failure(cause: unknown) {
  error.value = errorKey(cause) === "denied" ? "denied" : "error";
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
const filters = ["all", "active", "disabled", "deleted"] as const;
const filterLabel: Record<typeof filters[number], MessageKey> = { all: "allLive", active: "active", disabled: "disabled", deleted: "recycle" };
const counts = computed(() => Object.fromEntries(filters.map(key => [key, definitions.value.filter(row => key === "all" ? !row.deletedAt : state(row) === key).length])) as Record<typeof filters[number], number>);
// Recommended import: preview first, import only on confirmation; the server skips any existing slug.
const recommended = ref<RecommendedRow[] | null>(null);
const importing = ref(false);
const importError = ref<MessageKey | "">("");
const toImport = computed(() => recommended.value?.filter(row => row.status === "create").length ?? 0);
const rowState = (row: RecommendedRow): MessageKey => row.status === "create" ? "willImport" : row.status === "created" ? "imported" : row.reason === "deleted" ? "skippedDeleted" : "skippedExists";
async function previewImport() {
  importError.value = ""; importing.value = true;
  try { recommended.value = await props.api.recommended(); } catch (cause) { importError.value = errorKey(cause); recommended.value = []; }
  finally { importing.value = false; }
}
async function confirmImport() {
  importError.value = ""; importing.value = true;
  try { recommended.value = await props.api.importRecommended(); await refresh(); } catch (cause) { importError.value = errorKey(cause); }
  finally { importing.value = false; }
}
const updated = (value?: string) => value ? new Date(value).toLocaleString(locale.value, { dateStyle: "medium", timeStyle: "short" }) : "";
</script>

<template>
  <section class="agent-management" aria-labelledby="agent-management-title">
    <header class="management-heading">
      <button v-if="closable" type="button" class="icon" :title="label('close')" :aria-label="label('close')" @click="emit('close')"><ArrowLeft :size="20" /></button>
      <div class="heading-copy"><h1 id="agent-management-title">{{ label('title') }}</h1>
        <p class="subtitle">{{ label('active') }} {{ counts.active }} · {{ label('disabled') }} {{ counts.disabled }}</p></div>
      <button type="button" class="icon" :title="label('refresh')" :aria-label="label('refresh')" :disabled="loading" @click="refresh"><RefreshCw :size="18" :class="{ spin: loading }" /></button>
      <button v-if="catalog?.capabilities.create" type="button" :disabled="importing" @click="previewImport"><Sparkles :size="16" /><span class="create-text">{{ label('importRecommended') }}</span></button>
      <button v-if="catalog?.capabilities.create" type="button" class="primary" :title="label('create')" :aria-label="label('create')" @click="creating = true"><Plus :size="16" /><span class="create-text">{{ label('create') }}</span></button>
    </header>
    <div class="management-toolbar">
      <label class="search"><Search :size="16" aria-hidden="true" /><input v-model="query" type="search" :aria-label="label('search')" :placeholder="label('search')" /></label>
      <div class="filter-pills" role="group" :aria-label="label('all')">
        <button v-for="value in filters" :key="value" type="button" :aria-pressed="filter === value" @click="filter = value">{{ label(filterLabel[value]) }}<span class="count">{{ counts[value] }}</span></button>
      </div>
    </div>
    <p v-if="error" role="alert" class="error-card">{{ label(error) }} <button type="button" class="ghost" @click="refresh">{{ label('retry') }}</button></p>
    <ul v-if="loading && !definitions.length" class="agent-grid" role="status" :aria-label="label('loading')"><li v-for="n in 6" :key="n" class="skeleton-card"></li></ul>
    <div v-else-if="!visible.length" class="empty"><Bot :size="36" aria-hidden="true" /><p>{{ label(definitions.length ? 'empty' : 'noAgents') }}</p>
      <button v-if="!definitions.length && catalog?.capabilities.create" type="button" class="primary" @click="creating = true"><Plus :size="16" />{{ label('create') }}</button></div>
    <ul v-else class="agent-grid" :aria-busy="loading">
      <li v-for="(definition, index) in visible" :key="definition.id">
        <button type="button" class="agent-card" :class="[`delay-${Math.min(index + 1, 9)}`, { selected: selected?.definition.id === definition.id, gone: !!definition.deletedAt }]" :data-definition-id="definition.id" @click="open(definition.id)">
          <span class="card-top">
            <img v-if="avatar(definition) && !failedAvatars.has(avatar(definition))" :src="avatar(definition)" alt="" class="agent-avatar" referrerpolicy="no-referrer" @error="failedAvatars.add(avatar(definition))" />
            <span v-else class="agent-avatar fallback" :style="{ background: avatarGradient(definition.id) }" aria-hidden="true">{{ initial(definition.name) }}</span>
            <span class="agent-copy"><strong>{{ definition.name }}</strong><small class="slug" :title="`#${definition.id} · ${definition.slug}`">{{ definition.slug }}</small></span>
            <span class="pill state" :class="state(definition)">{{ label(state(definition)) }}</span>
          </span>
          <span class="description">{{ definition.config?.description }}</span>
          <span class="card-foot"><span class="pill model">{{ readPath(definition, '/config/defaults/model') || label('inherit') }}</span>
            <span v-if="definition.updatedAt" class="updated" :title="label('updated')"><Clock :size="12" aria-hidden="true" />{{ updated(definition.updatedAt) }}</span></span>
        </button>
      </li>
    </ul>
    <DefinitionDrawer v-if="selected" :key="selected.definition.id" :api="api" :detail="selected" :catalog="catalog" @close="closeDetail" @changed="changed" />
    <div v-if="recommended" class="import-backdrop" @click.self="recommended = null">
      <section class="import-dialog" role="dialog" aria-modal="true" aria-labelledby="import-title">
        <h2 id="import-title">{{ label('importRecommended') }}</h2>
        <p class="subtitle">{{ label('importNote') }}</p>
        <p v-if="importError" role="alert" class="error-card">{{ label(importError) }}</p>
        <ul class="import-rows"><li v-for="row in recommended" :key="row.slug" :data-slug="row.slug"><span><strong>{{ row.name }}</strong><small>{{ row.description }}</small></span>
          <span class="pill" :class="{ active: row.status !== 'skipped' }">{{ label(rowState(row)) }}</span></li></ul>
        <p v-if="recommended.length && !toImport" role="status" class="subtitle">{{ label('nothingToImport') }}</p>
        <div class="import-actions"><button type="button" @click="recommended = null">{{ label('close') }}</button>
          <button v-if="toImport" type="button" class="primary" :disabled="importing" @click="confirmImport">{{ label('confirmImport') }} ({{ toImport }})</button></div>
      </section>
    </div>
    <CreateDefinition v-if="creating && catalog" :api="api" :catalog="catalog" @close="creating = false" @created="created" />
  </section>
</template>

<style scoped src="./theme.css"></style>
<style scoped>
.agent-management { position: relative; color: var(--text-primary); background: var(--bg); min-height: 100%; padding: 24px 28px; box-sizing: border-box; font-family: var(--font-body); isolation: isolate; }
.agent-management::before { content: ""; position: absolute; inset: 0; z-index: -1; background: var(--grad-mesh); pointer-events: none; }
.management-heading { display: flex; gap: 10px; align-items: center; } .heading-copy { flex: 1; min-width: 0; }
h1 { font-size: 22px; margin: 0; overflow-wrap: anywhere; } .subtitle { margin: 2px 0 0; font-size: 12.5px; color: var(--text-secondary); }
button, input { font: inherit; color: inherit; } button { cursor: pointer; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 40px; padding: 6px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-card); font-size: 12.5px; transition: all .2s var(--ease); }
.icon { width: 40px; padding: 0; flex-shrink: 0; }
.primary { border: 0; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #fff; background: var(--grad-teal-indigo); background-size: 200% 200%; transition: all .25s var(--ease); }
.primary:hover { transform: translateY(-1px); box-shadow: var(--shadow-teal); background-position: 100% 0; }
button:disabled { opacity: .5; cursor: not-allowed; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.management-toolbar { display: flex; gap: 12px; margin: 20px 0 16px; flex-wrap: wrap; align-items: center; }
.search { flex: 1; min-width: min(240px, 100%); display: flex; align-items: center; gap: 8px; padding: 0 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-card); color: var(--text-tertiary); transition: border-color .2s var(--ease); }
.search:focus-within { border-color: var(--accent); } .search input { min-width: 0; width: 100%; min-height: 40px; border: 0; outline: 0; background: transparent; color: var(--text-primary); }
.filter-pills { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; }
.filter-pills button { border-radius: var(--r-full); min-height: 34px; padding: 4px 12px; white-space: nowrap; color: var(--text-secondary); }
.filter-pills [aria-pressed=true] { border-color: var(--accent); background: var(--teal-50); color: var(--teal-700); font-weight: 600; }
.count { font-size: 11px; padding: 0 6px; border-radius: var(--r-full); background: var(--bg-subtle); }
.agent-grid { list-style: none; padding: 0; margin: 0; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; }
.agent-card { width: 100%; height: 100%; display: grid; gap: 10px; align-content: start; text-align: start; padding: 14px 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-card); box-shadow: var(--shadow-xs); transition: all .25s var(--ease); animation-name: fade-in-up; animation-duration: .5s; animation-timing-function: var(--ease-out); animation-fill-mode: both; }
.agent-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md); } .agent-card.selected { border-color: var(--accent); box-shadow: var(--shadow-teal); } .agent-card.gone { opacity: .6; }
.card-top { display: flex; gap: 10px; align-items: center; min-width: 0; }
.agent-avatar { display: grid; place-items: center; width: 40px; height: 40px; border-radius: var(--r-md); object-fit: cover; color: #fff; font-weight: 700; flex-shrink: 0; }
.agent-copy { min-width: 0; flex: 1; display: grid; } strong { font-size: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.slug { font-size: 11.5px; color: var(--text-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.description { font-size: 12.5px; color: var(--text-secondary); min-height: 2.8em; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.card-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-width: 0; }
.pill { font-size: 11.5px; padding: 2px 8px; border-radius: var(--r-full); background: var(--slate-100); color: var(--slate-700); white-space: nowrap; flex-shrink: 0; }
.pill.active { background: #ecfdf5; color: #047857; } .pill.deleted { background: #fff1f2; color: #be123c; } .pill.model { background: var(--teal-50); color: var(--teal-700); overflow: hidden; text-overflow: ellipsis; flex-shrink: 1; }
.updated { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-tertiary); white-space: nowrap; }
.skeleton-card { height: 128px; border-radius: var(--r-lg); background: linear-gradient(90deg, var(--bg-subtle) 25%, var(--bg-hover) 50%, var(--bg-subtle) 75%); background-size: 200% 100%; animation: shimmer 1.5s linear infinite; }
.empty { display: grid; justify-items: center; gap: 8px; padding: 64px 0; color: var(--text-tertiary); } .empty p { margin: 0; font-size: 13.5px; }
.error-card { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 10px 14px; border-radius: var(--r-md); background: #fff1f2; color: #be123c; font-size: 13px; }
.spin { animation: spin 1s linear infinite; }
.import-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 16px; background: rgb(15 23 42 / .35); }
.import-dialog { width: min(520px, 100%); max-height: 90dvh; overflow: auto; display: grid; gap: 12px; padding: 20px; border-radius: var(--r-lg); background: var(--bg-card); box-shadow: var(--shadow-xl); }
.import-dialog h2 { margin: 0; font-size: 17px; } .import-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.import-rows li { display: flex; justify-content: space-between; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--r-md); }
.import-rows span:first-child { display: grid; min-width: 0; } .import-rows small { font-size: 12px; color: var(--text-secondary); }
.import-actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 1200px) { .agent-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 768px) { .agent-grid { grid-template-columns: minmax(0, 1fr); } }
@media (max-width: 600px) { .agent-management { padding: 14px 12px; } h1 { font-size: 18px; } .create-text { display: none; } .primary { width: 40px; padding: 0; } .empty .primary { width: auto; padding: 8px 16px; }
  .management-toolbar { margin: 14px 0 12px; } .filter-pills { width: 100%; } input { font-size: 16px; } }
@media (prefers-reduced-motion: reduce) { .agent-card, .skeleton-card, .spin { animation: none; } .primary:hover { transform: none; } }
</style>

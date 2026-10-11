<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Save, RefreshCw, Power, Trash2, RotateCcw, ChevronLeft, ChevronRight } from "@lucide/vue";
import DefinitionFields, { type ReadonlyField } from "./DefinitionFields.vue";
import ConflictComparison from "./ConflictComparison.vue";
import ToolEditor from "./ToolEditor.vue";
import { DefinitionError, type Catalog, type DefinitionApi, type Detail, type Impact, type LifecycleAction, type Audit, type Instance } from "./api";
import { DefinitionEditor, sameImpact } from "./state";
import { readPath, reconcileBindings, validateChanges } from "./draft";
import { text, type MessageKey } from "./messages";

const props = defineProps<{ api: DefinitionApi; detail: Detail; catalog?: Catalog }>();
const emit = defineEmits<{ close: []; changed: [detail: Detail] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const editor = reactive(new DefinitionEditor());
editor.open(props.detail);
const dialog = ref<HTMLDialogElement>();
const previousFocus = document.activeElement as HTMLElement | null;
const tab = ref<"fields" | "skills" | "tools" | "usage" | "audits">("fields");
const discard = ref(false);
const status = ref<MessageKey | "">("");
const catalogError = ref(false);
const models = ref<Awaited<ReturnType<DefinitionApi["models"]>>>([]);
const backends = ref<Awaited<ReturnType<DefinitionApi["backends"]>>>([]);
const action = ref<LifecycleAction | "save" | null>(null);
const impact = ref<Impact | null>(null);
const acknowledged = ref(false);
const typedSlug = ref("");
const acting = ref(false);
const bindingChoice = ref<"mine" | "current">();
const audits = ref<Audit[]>([]);
const instances = ref<Instance[]>([]);
const page = ref(0);
const total = ref(0);
const pageLoading = ref(false);
const toolId = ref<number>();
let mounted = true;
let readGeneration = 0;
let pageGeneration = 0;
const record = computed(() => editor.record!);
const operationLocked = computed(() => editor.busy || acting.value || editor.denied || editor.verificationRequired || !!editor.current);
const locked = computed(() => operationLocked.value || !!record.value.definition.deletedAt);
const writable = computed(() => record.value.capabilities.write && !locked.value);
const errors = computed(() => validateChanges(record.value.definition, editor.changes));
const provider = computed(() => Object.hasOwn(editor.changes, "/config/defaults/providerId")
  ? editor.changes["/config/defaults/providerId"] : readPath(record.value.definition, "/config/defaults/providerId"));
const providerChoices = computed(() => [...new Set(models.value.map(item => item.providerId))].map(id => ({ value: id, label: String(id) })));
const modelChoices = computed(() => models.value.filter(item => item.providerId === provider.value).map(item => ({ value: item.model, label: item.model })));
const readonlyFields = computed<ReadonlyField[]>(() => {
  const policy = record.value.fieldPolicy;
  const protectedPath = (path: string) => policy.protectedPaths.some(p => path === p || path.startsWith(`${p}/`));
  const known = policy.readOnlyPaths.map(path => ({ path, type: typeof readPath(record.value.definition, path),
    reason: policy.reasons[path] || label(path === "/slug" ? "readOnlySlug" : "readonly"),
    value: protectedPath(path) ? undefined : readPath(record.value.definition, path), hidden: protectedPath(path) }));
  return [...known, ...policy.protectedPaths.map(path => ({ path, type: "", reason: label("protectedReason"), hidden: true })),
    ...policy.unknownPaths.map(field => ({ ...field, reason: label("unknownReason"), hidden: true }))];
});
const selectedSkills = computed(() => (editor.bindings ?? record.value.skillBindings).map(item => item.skillId));
const availableSkills = computed(() => record.value.capabilities.readSkills
  ? [...new Map([...record.value.skills, ...(props.catalog?.skills ?? [])].map(skill => [skill.id, skill])).values()] : []);
const impactKeys = ["instances", "conversations", "conversations_7d", "skill_bindings", "im_groups", "deliverables"] as const;

function failure(error: unknown) {
  if (error instanceof DefinitionError && [401, 403].includes(error.status)) {
    editor.denied = true; editor.error = "denied";
  } else status.value = "error";
}
function revokeRead() {
  readGeneration++; pageGeneration++;
  editor.revokeRead();
  audits.value = []; instances.value = []; models.value = []; backends.value = [];
  toolId.value = undefined; action.value = null; impact.value = null;
}
async function refresh() {
  if (!editor.record) return;
  const generation = ++readGeneration;
  try {
    const current = await props.api.detail(record.value.definition.id);
    if (mounted && generation === readGeneration) editor.acceptRefresh(current);
  } catch (error) {
    if (mounted && generation === readGeneration) {
      if (error instanceof DefinitionError && [401, 403].includes(error.status)) revokeRead();
      else failure(error);
    }
  }
}
watch(() => props.detail, detail => editor.acceptRefresh(detail));
watch(() => editor.record, value => { if (!value) revokeRead(); });
function close() {
  if (editor.busy || acting.value) return;
  if (editor.dirty) discard.value = true;
  else emit("close");
}
function change(path: string, value: unknown) {
  editor.change(path, value);
  if (path === "/config/defaults/providerId") editor.change("/config/defaults/model", "");
}
function selectSkill(skillId: number, checked: boolean) {
  if (!writable.value || !record.value.capabilities.writeSkillBindings) return;
  const selected = selectedSkills.value.filter(id => id !== skillId);
  if (checked) selected.push(skillId);
  editor.bindings = reconcileBindings(record.value.skillBindings, selected,
    (props.catalog?.skills ?? []).map(skill => ({ skillId: skill.id, installPath: skill.defaultInstallPath ?? "" })));
}
function resolve(choices: Record<string, "mine" | "current">) {
  try { editor.resolve(choices, bindingChoice.value); bindingChoice.value = undefined; }
  catch { status.value = "bindingConflict"; }
}
async function prepare(next: LifecycleAction | "save") {
  if (!editor.record) return;
  if (operationLocked.value || (record.value.definition.deletedAt && next !== "restore")) return;
  if (next !== "save" && editor.dirty) return;
  status.value = ""; acting.value = true;
  const generation = readGeneration;
  try {
    const counted = await props.api.impact(record.value.definition.id);
    if (!mounted || generation !== readGeneration || !editor.record) return;
    impact.value = counted;
    acknowledged.value = false; typedSlug.value = ""; action.value = next;
  } catch (error) { if (mounted && generation === readGeneration) failure(error); }
  finally { if (mounted) acting.value = false; }
}
async function confirmAction() {
  if (!editor.record || !action.value || !impact.value || !acknowledged.value || operationLocked.value) return;
  if (action.value === "delete" && typedSlug.value !== record.value.definition.slug) return;
  acting.value = true; status.value = "";
  const generation = readGeneration;
  const baseline = record.value;
  const requestedAction = action.value;
  const stillCurrent = () => mounted && generation === readGeneration && editor.record !== null;
  let readingDetail = false;
  try {
    const fresh = await props.api.impact(baseline.definition.id);
    if (!stillCurrent() || !impact.value) return;
    if (!sameImpact(impact.value, fresh)) {
      impact.value = fresh; acknowledged.value = false; status.value = "impactChanged"; return;
    }
    readingDetail = true;
    const current = await props.api.detail(baseline.definition.id);
    readingDetail = false;
    if (!stillCurrent()) return;
    editor.acceptRefresh(current);
    if (!editor.record || editor.denied) return;
    if (current.etag !== baseline.etag || current.effective.revision !== baseline.effective.revision) {
      editor.acceptRefresh(current); acknowledged.value = false; status.value = "impactChanged"; return;
    }
    let saved: Detail | null;
    if (requestedAction === "save") saved = await editor.save(props.api);
    else saved = await props.api.lifecycle(current, requestedAction);
    if (!stillCurrent()) return;
    if (saved) { editor.open(saved); emit("changed", saved); status.value = "saved"; action.value = null; }
    else action.value = null;
  } catch (error) {
    if (!stillCurrent()) return;
    if (readingDetail && error instanceof DefinitionError && [401, 403].includes(error.status)) {
      revokeRead(); return;
    }
    failure(error);
    if (error instanceof DefinitionError && error.status === 412) { await refresh(); action.value = null; }
    else if (!(error instanceof DefinitionError) || error.status >= 500) {
      editor.verificationRequired = true; editor.error = "uncertain"; action.value = null;
    }
  } finally { if (mounted) acting.value = false; }
}
async function loadPage() {
  if (!editor.record) return;
  if (!["usage", "audits"].includes(tab.value)) return;
  const generation = ++pageGeneration;
  pageLoading.value = true; status.value = "";
  try {
    if (tab.value === "audits") {
      const result = await props.api.audits(record.value.definition.id, page.value * 20);
      if (generation !== pageGeneration || !mounted) return;
      audits.value = result.items; total.value = result.total;
    } else {
      const result = await props.api.instances(record.value.definition.id, page.value * 20);
      if (generation !== pageGeneration || !mounted) return;
      instances.value = result.items; total.value = result.total;
    }
  } catch (error) { if (mounted && generation === pageGeneration) failure(error); }
  finally { if (mounted && generation === pageGeneration) pageLoading.value = false; }
}
watch(tab, () => { page.value = 0; void loadPage(); });
watch(page, loadPage);
const when = (value: string | null) => value ? new Date(value).toLocaleString(locale.value) : "-";
function beforeUnload(event: BeforeUnloadEvent) { if (editor.dirty) { event.preventDefault(); event.returnValue = ""; } }
onMounted(async () => {
  dialog.value?.showModal();
  window.addEventListener("beforeunload", beforeUnload);
  const results = await Promise.allSettled([props.api.models(), props.api.backends()]);
  if (!mounted || !editor.record) return;
  if (results[0].status === "fulfilled") models.value = results[0].value;
  if (results[1].status === "fulfilled") backends.value = results[1].value;
  catalogError.value = results.some(result => result.status === "rejected");
});
onUnmounted(() => {
  mounted = false; readGeneration++; pageGeneration++;
  window.removeEventListener("beforeunload", beforeUnload);
  dialog.value?.close();
  void nextTick(() => previousFocus?.isConnected && previousFocus.focus());
});
</script>

<template>
  <dialog ref="dialog" class="definition-drawer" aria-labelledby="definition-title" @cancel.prevent="close">
    <header v-if="editor.record">
      <div><h2 id="definition-title">{{ record.definition.name }}</h2><small>Core #{{ record.definition.id }} · {{ label('revision') }} {{ record.definition.revision }}</small></div>
      <button type="button" class="icon" :title="label('close')" :aria-label="label('close')" @click="close"><X :size="20" /></button>
    </header>
    <div v-if="!editor.record" class="drawer-body"><p role="alert">{{ label('readDenied') }}</p><button type="button" @click="emit('close')">{{ label('close') }}</button></div>
    <div v-else class="drawer-body">
      <p v-if="editor.error || status" role="alert">{{ label((editor.error || status) as MessageKey) }}</p>
      <section v-if="discard" class="confirmation" role="alertdialog" :aria-label="label('discard')">
        <h3>{{ label('discard') }}</h3>
        <button type="button" @click="discard = false">{{ label('keepEditing') }}</button>
        <button type="button" class="danger" @click="emit('close')">{{ label('discardChanges') }}</button>
      </section>
      <template v-else-if="action && impact">
        <h3>{{ label('impact') }} · {{ label(action) }}</h3>
        <p>{{ label(action === 'restore' ? 'restoreNote' : action === 'save' || action === 'enable' ? 'nextTurn' : 'lifecycleNote') }}</p>
        <dl class="facts"><template v-for="key in impactKeys" :key="key"><dt>{{ label(key) }}</dt><dd>{{ impact[key] ?? label('unknown') }}</dd></template></dl>
        <p>{{ label('counted') }}: {{ when(impact.counted_at) }}</p>
        <label v-if="action === 'delete'" class="stack">{{ label('confirmSlug') }}: <code>{{ record.definition.slug }}</code><input v-model="typedSlug" autocomplete="off" /></label>
        <label class="check"><input v-model="acknowledged" type="checkbox" />{{ label('acknowledge') }}</label>
        <div class="commands"><button type="button" :disabled="acting" @click="action = null">{{ label('cancel') }}</button>
          <button type="button" :disabled="!acknowledged || acting || (action === 'delete' && typedSlug !== record.definition.slug)" @click="confirmAction">{{ label(acting ? 'saving' : action) }}</button></div>
      </template>
      <template v-else>
        <dl class="facts">
          <dt>{{ label('identity') }}</dt><dd>{{ record.identity.uid ?? '-' }} · {{ label(record.identity.status === 'ready' ? 'saved' : record.identity.status === 'pending' ? 'provisioning' : 'failed') }}</dd>
          <dt>{{ label('effective') }}</dt><dd><code>{{ record.effective.revision }}</code></dd>
        </dl>
        <p class="muted">{{ label('readOnlyIdentity') }}</p>
        <p class="muted">{{ label('nextTurn') }}</p>
        <div class="commands">
          <button v-if="record.identity.status === 'failed' && writable && record.capabilities.writeIdentity" type="button" @click="prepare('retry')"><RefreshCw :size="16" />{{ label('identityRetry') }}</button>
          <button v-if="writable && record.capabilities.writeIdentity" type="button" :disabled="editor.dirty || editor.verificationRequired || (!record.definition.isActive && record.identity.status !== 'ready')" @click="prepare(record.definition.isActive ? 'disable' : 'enable')"><Power :size="16" />{{ label(record.definition.isActive ? 'disable' : 'enable') }}</button>
          <button v-if="record.capabilities.delete && !record.definition.deletedAt" type="button" class="danger" :disabled="locked || editor.dirty || record.definition.isActive" @click="prepare('delete')"><Trash2 :size="16" />{{ label('delete') }}</button>
          <button v-if="record.capabilities.restore && record.definition.deletedAt" type="button" :disabled="operationLocked" @click="prepare('restore')"><RotateCcw :size="16" />{{ label('restore') }}</button>
        </div>
        <nav class="definition-tabs" :aria-label="label('title')">
          <button v-for="view in (['fields', 'skills', 'tools', 'usage', 'audits'] as const)" :key="view" type="button" :aria-current="tab === view ? 'page' : undefined" @click="tab = view">{{ label(view) }}</button>
        </nav>
        <template v-if="editor.current">
          <fieldset v-if="editor.bindingConflict"><legend>{{ label('bindingConflict') }}</legend>
            <pre>{{ label('mine') }}: {{ editor.bindings }}</pre><pre>{{ label('current') }}: {{ editor.current.skillBindings }}</pre>
            <label class="check"><input v-model="bindingChoice" type="radio" value="mine" name="bindings" />{{ label('mine') }}</label>
            <label class="check"><input v-model="bindingChoice" type="radio" value="current" name="bindings" />{{ label('current') }}</label>
          </fieldset>
          <ConflictComparison :baseline="record.definition" :changes="editor.changes" :current="editor.current.definition" @resolve="resolve" />
        </template>
        <template v-if="tab === 'fields'">
          <p v-if="catalogError" role="status">{{ label('catalogError') }}</p>
          <DefinitionFields :baseline="record.definition" :changes="editor.changes" :editable-paths="writable ? record.fieldPolicy.editablePaths : []"
            :readonly-fields="readonlyFields" :backends="backends.map(item => ({ value: item.id, label: item.displayName }))"
            :providers="providerChoices" :models="modelChoices" :busy="locked" @change="change" />
        </template>
        <section v-else-if="tab === 'skills'">
          <p v-if="!record.capabilities.readSkills">{{ label('readonly') }}</p>
          <p v-else-if="!availableSkills.length">{{ label('emptyResources') }}</p>
          <label v-for="skill in availableSkills" :key="skill.id" class="resource">
            <input type="checkbox" :checked="selectedSkills.includes(skill.id)" :disabled="!writable || !record.capabilities.writeSkillBindings || (!skill.isActive && !selectedSkills.includes(skill.id))"
              @change="selectSkill(skill.id, ($event.target as HTMLInputElement).checked)" />
            <span><strong>{{ skill.name }}</strong><small>{{ skill.slug }} · {{ skill.version }} · {{ skill.sourceSHA256 }}</small>
              <small>{{ label('installPath') }}: {{ (editor.bindings ?? record.skillBindings).find(item => item.skillId === skill.id)?.installPath || label('inherit') }}</small></span>
          </label>
        </section>
        <section v-else-if="tab === 'tools'">
          <p>{{ label('sharedNote') }}</p><p v-if="!record.tools.length">{{ label('emptyResources') }}</p>
          <article v-for="tool in record.tools" :key="tool.id" class="resource">
            <div><strong>{{ tool.name }}</strong><small>{{ tool.slug }} · {{ label('revision') }} {{ tool.revision }}</small><small>{{ label('source') }}: {{ tool.source || label('unknown') }}</small></div>
            <button v-if="record.capabilities.readTools" type="button" @click="toolId = tool.id">{{ label('edit') }}</button>
          </article>
        </section>
        <section v-else>
          <p v-if="pageLoading" role="status">{{ label('loading') }}</p>
          <div class="table-scroll">
            <table v-if="tab === 'usage'"><thead><tr><th>{{ label('user') }}</th><th>{{ label('firstUse') }}</th><th>{{ label('conversations') }}</th><th>{{ label('lastUse') }}</th></tr></thead>
              <tbody><tr v-for="row in instances" :key="row.instanceId"><td>{{ row.nickName }} #{{ row.userId }}</td><td>{{ when(row.firstUsedAt) }}</td><td>{{ row.sessionCount }}</td><td>{{ when(row.lastSessionAt) }}</td></tr></tbody></table>
            <ol v-else class="audit-list"><li v-for="row in audits" :key="row.id"><strong>{{ row.action }}</strong> · UID {{ row.actorUserId }} · {{ when(row.createdAt) }}
              <p>{{ row.fields.join(', ') }}</p><code v-if="row.promptSha256Before || row.promptSha256After">SHA256 {{ row.promptSha256Before.slice(0, 12) }} / {{ row.promptSha256After.slice(0, 12) }}</code></li></ol>
          </div>
          <div class="commands"><button type="button" :disabled="!page || pageLoading" :title="label('previous')" :aria-label="label('previous')" @click="page--"><ChevronLeft :size="18" /></button>
            <span>{{ page + 1 }} / {{ Math.max(1, Math.ceil(total / 20)) }}</span>
            <button type="button" :disabled="(page + 1) * 20 >= total || pageLoading" :title="label('next')" :aria-label="label('next')" @click="page++"><ChevronRight :size="18" /></button></div>
        </section>
      </template>
    </div>
    <footer v-if="editor.record && !action && !discard">
      <button type="button" class="icon" :disabled="editor.busy || acting" :title="label('refresh')" :aria-label="label('refresh')" @click="refresh"><RefreshCw :size="18" /></button>
      <span class="muted">{{ editor.dirty ? '' : label('noChanges') }}</span>
      <button v-if="editor.verificationRequired" type="button" @click="refresh">{{ label('queryResult') }}</button>
      <button v-if="record.capabilities.write" type="button" class="primary" :disabled="!writable || !editor.dirty || !!editor.current || editor.verificationRequired || !!Object.keys(errors).length" @click="prepare('save')"><Save :size="18" />{{ label(editor.busy ? 'saving' : 'save') }}</button>
    </footer>
    <ToolEditor v-if="toolId" :id="toolId" :api="api" @close="toolId = undefined" @changed="refresh" />
  </dialog>
</template>

<style scoped>
.definition-drawer { box-sizing: border-box; position: fixed; inset: 0 0 0 auto; margin: 0; width: min(760px, 94vw); max-width: 100%; height: 100dvh; max-height: 100dvh; padding: 0; border: 0; border-left: 1px solid var(--border); background: var(--bg-card, Canvas); color: var(--text-primary, CanvasText); }
.definition-drawer[open] { display: flex; flex-direction: column; }
::backdrop { background: #0006; }
header, footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 16px 24px; flex-shrink: 0; border-bottom: 1px solid var(--border); }
header > div { min-width: 0; } h2 { font-size: 20px; margin: 0 0 4px; overflow-wrap: anywhere; } h3 { font-size: 16px; }
footer { border-top: 1px solid var(--border); border-bottom: 0; }
.drawer-body { padding: 20px 24px; overflow: auto; min-height: 0; flex: 1; }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 44px; border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; background: var(--bg-card, Canvas); color: inherit; font: inherit; cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; } button.primary { background: var(--accent, #16796c); color: white; }
.icon { width: 44px; flex-shrink: 0; padding: 8px; } .danger { color: var(--rose-500, #c13247); }
:focus-visible { outline: 2px solid var(--accent, #16796c); outline-offset: 2px; }
.commands, .definition-tabs { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 16px 0; }
.definition-tabs { border-bottom: 1px solid var(--border); gap: 0; }
.definition-tabs button { border: 0; border-radius: 0; border-bottom: 2px solid transparent; }
.definition-tabs [aria-current] { border-bottom-color: var(--accent, #16796c); font-weight: 600; }
.facts { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 8px 16px; font-size: 13px; }
dd { margin: 0; overflow-wrap: anywhere; } small, .muted, dt { color: var(--text-secondary, GrayText); font-size: 12px; }
.resource { display: flex; gap: 12px; align-items: center; padding: 14px 0; border-bottom: 1px solid var(--border); } .resource span, .resource div { min-width: 0; flex: 1; } .resource small { display: block; margin-top: 5px; overflow-wrap: anywhere; }
input[type=checkbox], input[type=radio] { width: 22px; height: 22px; accent-color: var(--accent, #16796c); flex-shrink: 0; }
.check { display: flex; align-items: center; gap: 10px; min-height: 48px; } .stack { display: grid; gap: 8px; }
.stack input { min-height: 44px; box-sizing: border-box; width: 100%; color: inherit; background: var(--bg-card, Canvas); border: 1px solid var(--border); padding: 8px; font: inherit; }
.table-scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { text-align: start; padding: 10px; border-bottom: 1px solid var(--border); }
.audit-list { list-style: none; padding: 0; font-size: 13px; } .audit-list li { padding: 12px 0; border-bottom: 1px solid var(--border); }
pre, code { white-space: pre-wrap; overflow-wrap: anywhere; } fieldset { min-width: 0; }
@media (max-width: 600px) { .definition-drawer { width: 100%; } header, footer, .drawer-body { padding: 14px 16px; } input { font-size: 16px !important; } }
</style>

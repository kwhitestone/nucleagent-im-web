<script setup lang="ts">
import { trapDialogFocus } from "./focus";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { X, Save, RefreshCw, Power, Trash2, RotateCcw, ChevronLeft, ChevronRight, LoaderCircle, Check, TriangleAlert, Wrench } from "@lucide/vue";
import DefinitionFields, { type ReadonlyField } from "./DefinitionFields.vue";
import ConflictComparison from "./ConflictComparison.vue";
import ToolEditor from "./ToolEditor.vue";
import SkillPicker from "./SkillPicker.vue";
import AgentPreview from "./AgentPreview.vue";
import { avatarGradient, avatarUrl, changeCount, dirtyGroups, groupPaths, groups, initial, type Group } from "./groups";
import { DefinitionError, type Catalog, type DefinitionApi, type Detail, type Impact, type LifecycleAction, type Audit, type Instance } from "./api";
import { DefinitionEditor, sameImpact } from "./state";
import { definitionFields, readPath, reconcileBindings, validateChanges } from "./draft";
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
  else leave();
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
// --- presentation only (UI-IMPL-2): no request, ETag or idempotency logic below ---
const closing = ref(false);
function leave() { if (closing.value) return; closing.value = true; setTimeout(() => emit("close"), 200); }
const groupLabel: Record<Group, MessageKey> = { basic: "basic", persona: "persona", model: "groupModel", skills: "groupSkills", visibility: "visibility", history: "history", advanced: "advanced" };
const allPaths = definitionFields.map(field => field.path);
const activeGroup = ref<Group>("basic");
const body = ref<HTMLElement>();
const dirtyGroupSet = computed(() => dirtyGroups(editor.changes, editor.bindings));
const pending = computed(() => changeCount(editor.changes, editor.bindings));
const canSave = computed(() => record.value.capabilities.write && writable.value && editor.dirty && !editor.current && !editor.verificationRequired && !Object.keys(errors.value).length);
const draftValue = (path: string) => Object.hasOwn(editor.changes, path) ? editor.changes[path] : readPath(record.value.definition, path);
const draftName = computed(() => String(draftValue("/name") ?? ""));
const headerAvatar = computed(() => avatarUrl(draftValue("/config/avatar")));
const alertKey = computed(() => (editor.error === "conflict" && editor.current) ? "" : editor.error || (status.value === "saved" ? "" : status.value));
const installPath = (id: number) => (editor.bindings ?? record.value.skillBindings).find(item => item.skillId === id)?.installPath || "";
function goTo(group: Group) {
  activeGroup.value = group;
  if (group === "history" && !["usage", "audits"].includes(tab.value)) tab.value = "usage";
  body.value?.querySelector(`#group-${group}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
}
function onNavKey(event: KeyboardEvent) {
  const step = ["ArrowDown", "ArrowRight"].includes(event.key) ? 1 : ["ArrowUp", "ArrowLeft"].includes(event.key) ? -1 : 0;
  if (!step) return;
  event.preventDefault();
  const next = groups[(groups.indexOf(activeGroup.value) + step + groups.length) % groups.length]!;
  goTo(next);
  void nextTick(() => (dialog.value?.querySelector(`[role=tab][data-group="${next}"]`) as HTMLElement | null)?.focus());
}
function onScroll() {
  const top = body.value?.getBoundingClientRect().top ?? 0;
  const passed = groups.filter(group => (body.value?.querySelector(`#group-${group}`)?.getBoundingClientRect().top ?? Infinity) - top < 80);
  if (passed.length) activeGroup.value = passed.at(-1)!;
}
function shortcut(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (canSave.value && !action.value && !discard.value) void prepare("save");
  }
}
function onKey(event: KeyboardEvent) { trapDialogFocus(event); shortcut(event); }
function escape() { if (action.value && !acting.value) action.value = null; else if (discard.value) discard.value = false; else close(); }
let toastTimer: ReturnType<typeof setTimeout> | undefined;
watch(status, value => { clearTimeout(toastTimer); if (value === "saved") toastTimer = setTimeout(() => { if (status.value === "saved") status.value = ""; }, 3000); });
watch(() => [discard.value, action.value], () => void nextTick(() => (dialog.value?.querySelector(".overlay-dialog button") as HTMLElement | null)?.focus()));
onUnmounted(() => clearTimeout(toastTimer));
</script>

<template>
  <dialog ref="dialog" class="definition-drawer" :class="{ closing }" aria-labelledby="definition-title" @cancel.prevent="escape" @keydown="onKey">
    <header v-if="editor.record" class="drawer-head">
      <img v-if="headerAvatar" :src="headerAvatar" alt="" class="head-avatar" referrerpolicy="no-referrer" />
      <span v-else class="head-avatar" :style="{ background: avatarGradient(record.definition.id) }" aria-hidden="true">{{ initial(draftName) }}</span>
      <div class="head-copy">
        <h2 id="definition-title">{{ record.definition.name }}
          <span v-if="pending" class="unsaved-badge" aria-live="polite">● {{ label('unsaved') }} {{ pending }}{{ label('changesUnit') }}</span>
          <span v-else class="sr-only" aria-live="polite"></span>
          <span v-if="record.definition.deletedAt" class="pill deleted">{{ label('deleted') }}</span>
        </h2>
        <small>#{{ record.definition.id }} · {{ record.definition.slug }} · <span :key="record.definition.revision" class="revision">{{ label('revision') }} {{ record.definition.revision }}</span></small>
      </div>
      <div class="head-actions">
        <button v-if="writable && record.capabilities.writeIdentity" type="button" class="ghost" :title="editor.dirty ? label('unsavedHint') : undefined" :disabled="editor.dirty || editor.verificationRequired || (!record.definition.isActive && record.identity.status !== 'ready')" @click="prepare(record.definition.isActive ? 'disable' : 'enable')"><Power :size="15" />{{ label(record.definition.isActive ? 'disable' : 'enable') }}</button>
        <button v-if="record.capabilities.delete && !record.definition.deletedAt" type="button" class="ghost danger" :title="editor.dirty ? label('unsavedHint') : undefined" :disabled="locked || editor.dirty || record.definition.isActive" @click="prepare('delete')"><Trash2 :size="15" />{{ label('delete') }}</button>
        <button v-if="record.capabilities.restore && record.definition.deletedAt" type="button" class="ghost" :disabled="operationLocked" @click="prepare('restore')"><RotateCcw :size="15" />{{ label('restore') }}</button>
        <button type="button" class="icon" :title="label('close')" :aria-label="label('close')" @click="close"><X :size="18" /></button>
      </div>
    </header>
    <div v-if="!editor.record" class="drawer-body"><p role="alert">{{ label('readDenied') }}</p><button type="button" @click="emit('close')">{{ label('close') }}</button></div>
    <div v-else class="drawer-grid">
      <nav class="group-nav" role="tablist" aria-orientation="vertical" :aria-label="label('title')" @keydown="onNavKey">
        <button v-for="group in groups" :key="group" type="button" role="tab" :data-group="group" :aria-selected="activeGroup === group" :tabindex="activeGroup === group ? 0 : -1" @click="goTo(group)">{{ label(groupLabel[group]) }}<span v-if="dirtyGroupSet.has(group)" class="dirty-dot" :aria-label="label('unsaved')"></span></button>
      </nav>
      <div ref="body" class="drawer-body" @scroll.passive="onScroll">
        <p v-if="alertKey" role="alert" class="notice" :class="editor.error === 'uncertain' ? 'warn' : 'error'"><TriangleAlert :size="16" aria-hidden="true" />{{ label(alertKey as MessageKey) }}
          <button v-if="editor.verificationRequired" type="button" class="ghost" @click="refresh">{{ label('queryResult') }}</button></p>
        <p v-if="!record.capabilities.write" class="notice muted-note">{{ label('viewOnly') }}</p>
        <section v-if="editor.current" class="conflict-card" aria-labelledby="conflict-title">
          <h3 id="conflict-title"><TriangleAlert :size="16" aria-hidden="true" />{{ label('conflictTitle') }} <small>({{ label('revision') }} {{ record.definition.revision }} → {{ editor.current.definition.revision }})</small></h3>
          <p>{{ label('conflictKeep') }}</p>
          <fieldset v-if="editor.bindingConflict" class="binding-conflict"><legend>{{ label('bindingConflict') }}</legend>
            <div class="binding-options">
              <label class="conflict-option" :class="{ chosen: bindingChoice === 'mine' }"><input v-model="bindingChoice" type="radio" value="mine" name="bindings" /><strong>{{ label('mine') }}</strong>
                <small>{{ (editor.bindings ?? []).map(b => availableSkills.find(s => s.id === b.skillId)?.name ?? `#${b.skillId}`).join(', ') || '—' }}</small></label>
              <label class="conflict-option" :class="{ chosen: bindingChoice === 'current' }"><input v-model="bindingChoice" type="radio" value="current" name="bindings" /><strong>{{ label('current') }}</strong>
                <small>{{ editor.current.skillBindings.map(b => availableSkills.find(s => s.id === b.skillId)?.name ?? `#${b.skillId}`).join(', ') || '—' }}</small></label>
            </div>
          </fieldset>
          <ConflictComparison :baseline="record.definition" :changes="editor.changes" :current="editor.current.definition" @resolve="resolve" />
        </section>
        <p v-if="catalogError" role="status" class="notice warn">{{ label('catalogError') }}</p>
        <section v-for="group in (['basic', 'persona', 'model'] as const)" :id="`group-${group}`" :key="group" class="form-card">
          <h3>{{ label(groupLabel[group]) }}<span v-if="dirtyGroupSet.has(group)" class="dirty-dot" aria-hidden="true"></span></h3>
          <DefinitionFields :only="groupPaths(group, allPaths)" :baseline="record.definition" :changes="editor.changes" :editable-paths="record.capabilities.write && !editor.denied ? record.fieldPolicy.editablePaths : []"
            :readonly-fields="readonlyFields" :backends="backends.map(item => ({ value: item.id, label: item.displayName }))"
            :providers="providerChoices" :models="modelChoices" :busy="locked" @change="change" />
        </section>
        <section id="group-skills" class="form-card">
          <h3>{{ label('groupSkills') }}<span v-if="dirtyGroupSet.has('skills')" class="dirty-dot" aria-hidden="true"></span></h3>
          <h4>{{ label('skills') }}</h4>
          <p v-if="!record.capabilities.readSkills" class="muted">{{ label('readonly') }}</p>
          <SkillPicker v-else :skills="availableSkills" :selected="selectedSkills" :editable="writable && record.capabilities.writeSkillBindings" :install-path="installPath" @toggle="selectSkill" />
          <h4>{{ label('tools') }}</h4>
          <p class="notice warn small"><TriangleAlert :size="14" aria-hidden="true" />{{ label('sharedNote') }}</p>
          <p v-if="!record.tools.length" class="muted">{{ label('emptyResources') }}</p>
          <article v-for="tool in record.tools" :key="tool.id" class="resource">
            <span class="tool-icon" aria-hidden="true"><Wrench :size="14" /></span>
            <div><strong>{{ tool.name }}</strong><small>{{ tool.slug }} · {{ label('revision') }} {{ tool.revision }}</small></div>
            <button v-if="record.capabilities.readTools" type="button" class="ghost" @click="toolId = tool.id">{{ label('edit') }}</button>
          </article>
        </section>
        <section id="group-visibility" class="form-card">
          <h3>{{ label('visibility') }}</h3>
          <p class="muted">{{ label('visibilityNote') }}</p>
          <dl class="facts">
            <template v-for="[key, allowed] in ([['canRead', record.capabilities.read], ['canWrite', record.capabilities.write], ['canSkills', record.capabilities.writeSkillBindings], ['canDelete', record.capabilities.delete]] as const)" :key="key">
              <dt>{{ label(key) }}</dt><dd><span class="pill" :class="allowed ? 'active' : 'disabled'">{{ label(allowed ? 'yes' : 'no') }}</span></dd></template>
          </dl>
        </section>
        <section id="group-history" class="form-card">
          <h3>{{ label('history') }}</h3>
          <div class="segmented" role="group" :aria-label="label('history')">
            <button v-for="view in (['usage', 'audits'] as const)" :key="view" type="button" :aria-pressed="tab === view" @click="tab = view">{{ label(view) }}</button>
          </div>
          <template v-if="tab === 'usage' || tab === 'audits'">
            <div v-if="pageLoading" role="status" class="skeleton-list" :aria-label="label('loading')"><span v-for="n in 3" :key="n" class="skeleton"></span></div>
            <div v-else class="table-scroll">
              <table v-if="tab === 'usage'"><thead><tr><th>{{ label('user') }}</th><th>{{ label('firstUse') }}</th><th>{{ label('conversations') }}</th><th>{{ label('lastUse') }}</th></tr></thead>
                <tbody><tr v-for="row in instances" :key="row.instanceId"><td>{{ row.nickName }} #{{ row.userId }}</td><td>{{ when(row.firstUsedAt) }}</td><td>{{ row.sessionCount }}</td><td>{{ when(row.lastSessionAt) }}</td></tr></tbody></table>
              <ol v-else class="audit-list"><li v-for="row in audits" :key="row.id"><strong>{{ row.action }}</strong> · UID {{ row.actorUserId }} · {{ when(row.createdAt) }}
                <p :title="row.fields.join(', ')">{{ row.fields.map(path => { const f = definitionFields.find(item => item.path === path); return f ? label(f.label as MessageKey) : path; }).join('、') }}</p></li></ol>
            </div>
            <div class="commands"><button type="button" class="icon" :disabled="!page || pageLoading" :title="label('previous')" :aria-label="label('previous')" @click="page--"><ChevronLeft :size="16" /></button>
              <span class="muted">{{ page + 1 }} / {{ Math.max(1, Math.ceil(total / 20)) }}</span>
              <button type="button" class="icon" :disabled="(page + 1) * 20 >= total || pageLoading" :title="label('next')" :aria-label="label('next')" @click="page++"><ChevronRight :size="16" /></button></div>
          </template>
          <button v-else type="button" class="ghost" @click="tab = 'usage'">{{ label('usage') }}</button>
        </section>
        <section id="group-advanced" class="form-card">
          <details class="advanced">
            <summary><h3>{{ label('advanced') }} · {{ label('technical') }}</h3></summary>
            <dl class="facts">
              <dt>{{ label('identity') }}</dt><dd>{{ record.identity.uid ?? '-' }} · {{ label(record.identity.status === 'ready' ? 'saved' : record.identity.status === 'pending' ? 'provisioning' : 'failed') }}</dd>
              <dt>{{ label('effective') }}</dt><dd><code>{{ record.effective.revision }}</code></dd>
            </dl>
            <p class="muted">{{ label('readOnlyIdentity') }}</p>
            <p class="muted">{{ label('nextTurn') }}</p>
            <button v-if="record.identity.status === 'failed' && writable && record.capabilities.writeIdentity" type="button" class="ghost" @click="prepare('retry')"><RefreshCw :size="15" />{{ label('identityRetry') }}</button>
            <DefinitionFields v-if="readonlyFields.length" :baseline="record.definition" :changes="{}" :editable-paths="[]" :readonly-fields="readonlyFields" :only="[]" :backends="[]" :providers="[]" :models="[]" busy />
          </details>
        </section>
        <AgentPreview class="inline-preview" :id="record.definition.id" :name="draftName" :description="String(draftValue('/config/description') ?? '')" :avatar="draftValue('/config/avatar')"
          :active="record.definition.isActive" :deleted="!!record.definition.deletedAt" :model="String(draftValue('/config/defaults/model') ?? '')" />
      </div>
      <AgentPreview class="side-preview" :id="record.definition.id" :name="draftName" :description="String(draftValue('/config/description') ?? '')" :avatar="draftValue('/config/avatar')"
        :active="record.definition.isActive" :deleted="!!record.definition.deletedAt" :model="String(draftValue('/config/defaults/model') ?? '')" />
      <div v-if="discard" class="overlay" @click.self="discard = false">
        <section class="overlay-dialog" role="alertdialog" aria-labelledby="discard-title" aria-modal="true">
          <h3 id="discard-title">{{ label('discard') }}</h3>
          <p>{{ label('discardCount') }}：{{ pending }}{{ label('changesUnit') }}</p>
          <div class="commands end"><button type="button" class="ghost" @click="discard = false">{{ label('keepEditing') }}</button>
            <button type="button" class="ghost danger outline" @click="leave">{{ label('discardChanges') }}</button></div>
        </section>
      </div>
      <div v-else-if="action && impact" class="overlay">
        <section class="overlay-dialog" :class="{ dangerous: action === 'delete' || action === 'disable' }" role="alertdialog" aria-labelledby="impact-title" aria-modal="true">
          <h3 id="impact-title">{{ label('impact') }} · {{ label(action) }}</h3>
          <p class="muted">{{ label(action === 'restore' ? 'restoreNote' : action === 'save' || action === 'enable' ? 'nextTurn' : 'lifecycleNote') }}</p>
          <dl class="impact-grid"><div v-for="key in impactKeys" :key="key" class="stat" :class="{ hot: !!impact[key] }"><dt>{{ label(key) }}</dt><dd>{{ impact[key] ?? label('unknown') }}</dd></div></dl>
          <p class="muted">{{ label('counted') }}: {{ when(impact.counted_at) }}</p>
          <p v-if="status === 'impactChanged'" role="alert" class="notice warn">{{ label('impactChanged') }}</p>
          <label v-if="action === 'delete'" class="stack">{{ label('confirmSlug') }}: <code>{{ record.definition.slug }}</code><input v-model="typedSlug" autocomplete="off" /></label>
          <label class="check"><input v-model="acknowledged" type="checkbox" />{{ label('acknowledge') }}</label>
          <div class="commands end"><button type="button" class="ghost" :disabled="acting" @click="action = null">{{ label('cancel') }}</button>
            <button type="button" :class="action === 'delete' ? 'solid-danger' : 'primary'" :disabled="!acknowledged || acting || (action === 'delete' && typedSlug !== record.definition.slug)" @click="confirmAction"><LoaderCircle v-if="acting" :size="16" class="spin" />{{ label(acting ? 'saving' : action) }}</button></div>
        </section>
      </div>
    </div>
    <footer v-if="editor.record">
      <button type="button" class="icon" :disabled="editor.busy || acting" :title="label('refresh')" :aria-label="label('refresh')" @click="refresh"><RefreshCw :size="16" /></button>
      <span class="muted hint">{{ editor.dirty ? label('shortcuts') : label('noChanges') }}</span>
      <button v-if="editor.dirty && !editor.busy && !acting" type="button" class="ghost" @click="close">{{ label('discardChanges') }}</button>
      <button v-if="record.capabilities.write" type="button" class="primary" :disabled="!writable || !editor.dirty || !!editor.current || editor.verificationRequired || !!Object.keys(errors).length" @click="prepare('save')"><LoaderCircle v-if="editor.busy || acting" :size="16" class="spin" /><Save v-else :size="16" />{{ label(editor.busy ? 'saving' : 'save') }}</button>
    </footer>
    <p v-if="status === 'saved'" role="status" class="toast"><Check :size="16" aria-hidden="true" />{{ label('savedToast') }}</p>
    <ToolEditor v-if="toolId" :id="toolId" :api="api" @close="toolId = undefined" @changed="refresh" />
  </dialog>
</template>

<style scoped src="./theme.css"></style>
<style scoped>
.definition-drawer { box-sizing: border-box; position: fixed; inset: 0 0 0 auto; margin: 0; width: min(1040px, 94vw); max-width: 100%; height: 100dvh; max-height: 100dvh; padding: 0; border: 0; border-left: 1px solid var(--border); background: var(--bg); color: var(--text-primary); box-shadow: var(--shadow-lg); font-family: var(--font-body); }
.definition-drawer[open] { display: flex; flex-direction: column; animation: slide-in-right .25s var(--ease-out) both; }
.definition-drawer::backdrop { background: rgba(15, 23, 42, .35); backdrop-filter: blur(3px); animation: fade-in .2s var(--ease-out) both; }
.definition-drawer.closing { opacity: 0; transform: translateX(24px); transition: opacity .2s var(--ease), transform .2s var(--ease); }
.definition-drawer.closing::backdrop { opacity: 0; transition: opacity .2s var(--ease); }
.drawer-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-card); flex-shrink: 0; }
.head-avatar { width: 40px; height: 40px; border-radius: var(--r-md); object-fit: cover; display: grid; place-items: center; color: #fff; font-weight: 700; flex-shrink: 0; }
.head-copy { min-width: 0; flex: 1; } .head-copy small { font-size: 12px; color: var(--text-tertiary); }
h2 { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 17px; margin: 0 0 2px; overflow-wrap: anywhere; }
.unsaved-badge { font-size: 11.5px; font-weight: 600; padding: 2px 9px; border-radius: var(--r-full); background: #fffbeb; color: #b45309; animation: scale-in .4s var(--ease-spring) both; }
.revision { display: inline-block; animation: scale-in .4s var(--ease-spring) both; }
.head-actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
.drawer-grid { position: relative; flex: 1; min-height: 0; display: grid; grid-template-columns: 180px minmax(0, 1fr) 280px; }
.group-nav { display: flex; flex-direction: column; gap: 2px; padding: 14px 10px; border-right: 1px solid var(--border); background: var(--bg-card); overflow: auto; }
.group-nav button { justify-content: space-between; min-height: 40px; border: 0; border-left: 3px solid transparent; border-radius: var(--r-sm); background: transparent; padding: 8px 10px; font-size: 13px; color: var(--text-secondary); text-align: start; transition: all .25s var(--ease); }
.group-nav button:hover { background: var(--bg-hover); color: var(--text-primary); }
.group-nav [aria-selected=true] { border-left-color: var(--accent); background: var(--teal-50); color: var(--teal-700); font-weight: 600; }
.dirty-dot { display: inline-block; width: 7px; height: 7px; margin-left: 6px; border-radius: 50%; background: var(--amber-500); flex-shrink: 0; animation: scale-in .4s var(--ease-spring) both; }
.drawer-body { padding: 16px 20px 32px; overflow: auto; min-height: 0; display: grid; gap: 14px; align-content: start; scroll-behavior: smooth; }
.side-preview { padding: 16px 14px; border-left: 1px solid var(--border); background: var(--bg-card); overflow: auto; }
.inline-preview { display: none; }
.form-card { scroll-margin-top: 12px; padding: 14px 16px 16px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-card); box-shadow: var(--shadow-xs); transition: all .25s var(--ease); animation: fade-in-up .5s var(--ease-out) both; }
.form-card:hover { border-color: var(--border-strong); }
.form-card h3 { display: flex; align-items: center; margin: 0 0 12px; font-size: 14px; } .form-card h4 { margin: 14px 0 8px; font-size: 12.5px; color: var(--text-secondary); }
.advanced summary { list-style: none; cursor: pointer; min-height: 32px; display: flex; align-items: center; } .advanced summary h3 { margin: 0; }
.advanced summary::before { content: "›"; margin-right: 8px; transition: transform .25s var(--ease); } .advanced[open] summary::before { transform: rotate(90deg); }
.conflict-card { padding: 14px 16px; border: 1px solid #fecdd3; border-radius: var(--r-lg); background: #fff1f2; animation: fade-in-up .5s var(--ease-out) both; display: grid; gap: 10px; }
.conflict-card h3 { display: flex; align-items: center; gap: 6px; margin: 0; font-size: 14px; color: #be123c; } .conflict-card > p { margin: 0; font-size: 13px; }
.binding-conflict { border: 0; padding: 0; margin: 0; min-width: 0; } .binding-conflict legend { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.binding-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.conflict-option { display: grid; gap: 4px; padding: 10px 12px; border: 1.5px solid var(--border); border-radius: var(--r-md); background: var(--bg-card); cursor: pointer; transition: all .2s var(--ease); }
.conflict-option.chosen { border-color: var(--accent); box-shadow: var(--shadow-teal); } .conflict-option input { accent-color: var(--accent); }
.notice { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 0; padding: 10px 12px; border-radius: var(--r-md); font-size: 13px; }
.notice.error { background: #fff1f2; color: #be123c; } .notice.warn { background: #fffbeb; color: #b45309; } .notice.small { font-size: 12px; padding: 8px 10px; }
.muted-note { background: var(--bg-subtle); color: var(--text-secondary); }
button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; border: 1px solid var(--border); border-radius: var(--r-md); padding: 6px 12px; background: var(--bg-card); color: inherit; font: inherit; font-size: 12.5px; cursor: pointer; transition: all .2s var(--ease); }
button:hover:not(:disabled) { border-color: var(--border-strong); background: var(--bg-hover); }
button:disabled { opacity: .5; cursor: not-allowed; }
button.primary { border: 0; padding: 8px 16px; font-size: 13px; font-weight: 600; color: #fff; background: var(--grad-teal-indigo); background-size: 200% 200%; transition: all .25s var(--ease); }
button.primary:hover:not(:disabled) { transform: translateY(-1px); box-shadow: var(--shadow-teal); background: var(--grad-teal-indigo); background-position: 100% 0; }
.danger { color: var(--rose-500); } .danger:hover:not(:disabled) { border-color: var(--rose-400); background: #fff1f2; } .outline { border-color: var(--rose-400); }
.solid-danger { border: 0; background: var(--rose-500); color: #fff; font-weight: 600; } .solid-danger:disabled { background: var(--bg-card); color: var(--rose-500); border: 1px solid var(--rose-400); }
.icon { width: 36px; padding: 0; border-color: transparent; background: transparent; color: var(--text-secondary); flex-shrink: 0; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
footer { display: flex; align-items: center; gap: 10px; padding: 10px 16px; border-top: 1px solid var(--border); background: var(--bg-card); flex-shrink: 0; } .hint { flex: 1; }
.muted, small, dt { color: var(--text-secondary); font-size: 12px; }
.facts { display: grid; grid-template-columns: minmax(100px, 1fr) minmax(0, 2fr); gap: 8px 16px; font-size: 13px; } dd { margin: 0; overflow-wrap: anywhere; }
.pill { font-size: 11.5px; padding: 2px 8px; border-radius: var(--r-full); background: var(--slate-100); color: var(--slate-700); font-weight: 500; }
.pill.active { background: #ecfdf5; color: #047857; } .pill.deleted { background: #fff1f2; color: #be123c; }
.resource { display: flex; gap: 10px; align-items: center; padding: 10px 12px; margin-top: 8px; border: 1px solid var(--border); border-radius: var(--r-md); } .resource div { min-width: 0; flex: 1; display: grid; }
.tool-icon { display: grid; place-items: center; width: 26px; height: 26px; border-radius: var(--r-sm); background: var(--bg-subtle); color: var(--text-secondary); }
.segmented { display: inline-flex; gap: 4px; padding: 3px; border-radius: var(--r-md); background: var(--bg-subtle); margin-bottom: 10px; }
.segmented button { border: 0; background: transparent; min-height: 32px; } .segmented [aria-pressed=true] { background: var(--bg-card); box-shadow: var(--shadow-xs); color: var(--teal-700); font-weight: 600; }
.skeleton-list { display: grid; gap: 8px; } .skeleton { height: 36px; border-radius: var(--r-md); background: linear-gradient(90deg, var(--bg-subtle) 25%, var(--bg-hover) 50%, var(--bg-subtle) 75%); background-size: 200% 100%; animation: shimmer 1.5s linear infinite; }
.table-scroll { overflow-x: auto; } table { border-collapse: collapse; width: 100%; font-size: 12.5px; } th, td { text-align: start; padding: 8px; border-bottom: 1px solid var(--border); } th { color: var(--text-secondary); font-weight: 600; }
.audit-list { list-style: none; padding: 0; margin: 0; font-size: 12.5px; } .audit-list li { padding: 10px 0; border-bottom: 1px solid var(--border); } .audit-list p { margin: 4px 0 0; color: var(--text-secondary); }
.commands { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; } .commands.end { justify-content: flex-end; }
.overlay { position: absolute; inset: 0; z-index: 5; display: grid; place-items: center; padding: 16px; background: rgba(15, 23, 42, .35); backdrop-filter: blur(3px); animation: fade-in .2s var(--ease-out) both; }
.overlay-dialog { width: min(480px, 100%); max-height: 100%; overflow: auto; box-sizing: border-box; padding: 18px 20px; border-radius: var(--r-xl); background: var(--bg-card); box-shadow: var(--shadow-xl); animation: scale-in .4s var(--ease-spring) both; }
.overlay-dialog h3 { margin: 0 0 8px; font-size: 16px; } .overlay-dialog.dangerous h3 { color: #be123c; }
.impact-grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin: 12px 0; } .stat { padding: 8px 10px; border-radius: var(--r-md); background: var(--bg-subtle); }
.stat dt { font-size: 11px; } .stat dd { font-size: 16px; font-weight: 600; } .stat.hot dd { color: var(--rose-500); font-weight: 700; }
.check { display: flex; align-items: center; gap: 10px; min-height: 44px; font-size: 13px; } .check input { width: 18px; height: 18px; accent-color: var(--accent); }
.stack { display: grid; gap: 6px; font-size: 13px; } .stack input { min-height: 40px; box-sizing: border-box; width: 100%; color: inherit; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r-md); padding: 8px 10px; font: inherit; }
.toast { position: absolute; right: 20px; bottom: 72px; z-index: 6; display: flex; align-items: center; gap: 8px; margin: 0; padding: 10px 14px; border-radius: var(--r-md); background: var(--slate-900); color: #fff; font-size: 13px; box-shadow: var(--shadow-lg); animation: slide-in-right .25s var(--ease-out) both; }
.spin { animation: spin 1s linear infinite; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
pre, code { white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: 12px; }
@media (max-width: 1200px) { .drawer-grid { grid-template-columns: 170px minmax(0, 1fr); } .side-preview { display: none; } .inline-preview { display: grid; } }
@media (max-width: 600px) {
  .definition-drawer { width: 100%; border-left: 0; }
  .drawer-head { padding: 10px 12px; } .head-avatar { width: 32px; height: 32px; } h2 { font-size: 15px; }
  .head-actions .ghost { display: none; }
  .drawer-grid { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(0, 1fr); }
  .group-nav { flex-direction: row; overflow-x: auto; padding: 8px 10px; border-right: 0; border-bottom: 1px solid var(--border); scrollbar-width: none; }
  .group-nav button { flex-shrink: 0; border-left: 0; border-radius: var(--r-full); padding: 6px 12px; min-height: 36px; border: 1px solid var(--border); white-space: nowrap; }
  .group-nav [aria-selected=true] { border-color: var(--accent); }
  .drawer-body { padding: 12px 12px 24px; }
  .binding-options, .impact-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  footer { padding: 10px 12px calc(10px + env(safe-area-inset-bottom)); } footer .hint { display: none; } footer .primary { flex: 1; min-height: 44px; } footer { justify-content: flex-end; }
  .toast { left: 12px; right: 12px; bottom: 76px; animation-name: fade-in-up; }
  input { font-size: 16px !important; }
}
@media (prefers-reduced-motion: reduce) {
  .definition-drawer[open], .definition-drawer::backdrop, .form-card, .conflict-card, .overlay, .overlay-dialog, .toast, .unsaved-badge, .dirty-dot, .revision { animation: none; }
  .definition-drawer.closing { transform: none; } .drawer-body { scroll-behavior: auto; } button.primary:hover:not(:disabled) { transform: none; }
}
</style>

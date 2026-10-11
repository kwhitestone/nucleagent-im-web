<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X, Save, RefreshCw, Plus } from "@lucide/vue";
import ConflictComparison from "./ConflictComparison.vue";
import { DefinitionError, schemaPropertyPath, toolChanges, type DefinitionApi, type ToolDetail } from "./api";
import { readPath, rebaseChanges, type Changes } from "./draft";
import { text, type MessageKey } from "./messages";

const props = defineProps<{ api: DefinitionApi; id: number }>();
const emit = defineEmits<{ close: []; changed: [] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const dialog = ref<HTMLDialogElement>();
const previousFocus = document.activeElement as HTMLElement | null;
const record = ref<ToolDetail>();
const current = ref<ToolDetail>();
const changes = ref<Changes>({});
const invalid = ref<Record<string, boolean>>({});
const rawJSON = ref<Record<string, string>>({});
const busy = ref(false);
const denied = ref(false);
const uncertain = ref(false);
const discard = ref(false);
const acknowledged = ref(false);
const propertyRule = ref(0);
const propertyName = ref("");
const propertyKeyword = ref("type");
const propertyJSON = ref('"string"');
const error = ref<MessageKey | "">("");
let mounted = true;
const dirty = computed(() => Object.keys(changes.value).length > 0 || Object.values(invalid.value).some(Boolean));
const locked = computed(() => busy.value || denied.value || uncertain.value || !record.value?.capabilities.write);
const fields = computed(() => [...new Set([...(record.value?.fieldPolicy.editablePaths ?? []), ...Object.keys(changes.value)])].filter(path =>
  !record.value?.fieldPolicy.protectedPaths.some(p => path === p || path.startsWith(`${p}/`))) ?? []);
const value = (path: string) => Object.hasOwn(changes.value, path) ? changes.value[path] : readPath(record.value?.tool, path);
const isJSON = (path: string) => path.startsWith("/config/mcp_config/input_schema/");
function selectPropertyRule() {
  const rules = record.value?.fieldPolicy.schemaPropertyRules ?? [];
  if (!rules[propertyRule.value]) propertyRule.value = 0;
  const keywords = rules[propertyRule.value]?.keywords ?? [];
  if (!keywords.includes(propertyKeyword.value)) propertyKeyword.value = keywords[0] ?? "";
}
function change(path: string, event: Event) {
  if (locked.value || !record.value) return;
  const input = event.target as HTMLInputElement;
  if (isJSON(path)) rawJSON.value[path] = input.value;
  try {
    const next = path === "/isActive" ? input.checked : isJSON(path) ? JSON.parse(input.value) : input.value;
    changes.value = toolChanges(record.value, { ...changes.value, [path]: next }); invalid.value[path] = false;
  } catch { invalid.value[path] = true; }
}
function addProperty() {
  if (locked.value || !record.value) return;
  const rule = record.value.fieldPolicy.schemaPropertyRules?.[propertyRule.value];
  if (!rule) return;
  try {
    const path = schemaPropertyPath(rule, propertyName.value, propertyKeyword.value);
    changes.value = toolChanges(record.value, { ...changes.value, [path]: JSON.parse(propertyJSON.value) });
    error.value = ""; propertyName.value = "";
  } catch { error.value = "invalid"; }
}
function failure(cause: unknown) {
  denied.value = cause instanceof DefinitionError && [401, 403].includes(cause.status);
  error.value = denied.value ? "denied" : "error";
}
function revokeRead() {
  record.value = undefined; current.value = undefined; changes.value = {}; invalid.value = {};
  rawJSON.value = {};
  denied.value = true; error.value = "readDenied";
}
function accept(fresh: ToolDetail) {
  if (!fresh.capabilities.read) { revokeRead(); return; }
  uncertain.value = false; denied.value = !fresh.capabilities.write;
  error.value = denied.value ? "denied" : "";
  if (dirty.value && record.value && fresh.etag !== record.value.etag) {
    record.value = { ...record.value, capabilities: fresh.capabilities, fieldPolicy: fresh.fieldPolicy };
    current.value = fresh; error.value = "conflict";
  } else record.value = fresh;
  selectPropertyRule();
}
async function refresh() {
  if (busy.value) return;
  busy.value = true;
  try {
    const fresh = await props.api.tool(props.id);
    if (!mounted) return;
    accept(fresh);
  } catch (cause) {
    if (mounted) {
      if (cause instanceof DefinitionError && [401, 403].includes(cause.status)) revokeRead();
      else failure(cause);
    }
  }
  finally { if (mounted) busy.value = false; }
}
async function save() {
  if (!record.value || locked.value || current.value || !dirty.value || !acknowledged.value || Object.values(invalid.value).some(Boolean)) return;
  busy.value = true;
  try {
    const saved = await props.api.patchTool(record.value, changes.value);
    if (!mounted) return;
    record.value = saved; changes.value = {}; rawJSON.value = {}; acknowledged.value = false; error.value = "saved"; emit("changed");
  } catch (cause) {
    if (!mounted) return;
    if (cause instanceof DefinitionError && cause.status === 412) {
      try {
        const fresh = await props.api.tool(props.id);
        if (!mounted) return;
        accept(fresh);
      } catch (e) {
        if (!mounted) return;
        if (e instanceof DefinitionError && [401, 403].includes(e.status)) revokeRead();
        else failure(e);
      }
    } else {
      failure(cause); uncertain.value = !(cause instanceof DefinitionError) || cause.status >= 500;
      if (uncertain.value) error.value = "uncertain";
    }
  } finally { if (mounted) busy.value = false; }
}
function resolve(choices: Record<string, "mine" | "current">) {
  if (!record.value || !current.value) return;
  changes.value = rebaseChanges(record.value.tool, changes.value, current.value.tool, choices);
  rawJSON.value = {}; invalid.value = {};
  record.value = current.value; current.value = undefined; acknowledged.value = false; error.value = "";
}
function close() { if (!busy.value) { if (dirty.value) discard.value = true; else emit("close"); } }
function beforeUnload(event: BeforeUnloadEvent) { if (dirty.value) { event.preventDefault(); event.returnValue = ""; } }
function onFocus() { if (document.visibilityState !== "hidden") void refresh(); }
onMounted(() => {
  dialog.value?.showModal(); void refresh(); window.addEventListener("beforeunload", beforeUnload);
  window.addEventListener("focus", onFocus); window.addEventListener("online", onFocus);
});
onUnmounted(() => {
  mounted = false; dialog.value?.close(); window.removeEventListener("beforeunload", beforeUnload);
  window.removeEventListener("focus", onFocus); window.removeEventListener("online", onFocus);
  void nextTick(() => previousFocus?.isConnected && previousFocus.focus());
});
</script>

<template>
  <dialog ref="dialog" class="definition-drawer" aria-labelledby="tool-editor-title" @cancel.prevent="close">
    <header><h2 id="tool-editor-title">{{ record?.tool.name || label('tools') }}</h2>
      <button type="button" class="icon" :title="label('close')" :aria-label="label('close')" @click="close"><X :size="20" /></button></header>
    <div class="drawer-body">
      <p>{{ label('sharedNote') }}</p><p v-if="error" role="alert">{{ label(error) }}</p>
      <p v-if="busy" role="status">{{ label('loading') }}</p>
      <section v-if="discard" role="alertdialog" :aria-label="label('discard')"><h3>{{ label('discard') }}</h3>
        <button type="button" @click="discard = false">{{ label('keepEditing') }}</button><button type="button" @click="emit('close')">{{ label('discardChanges') }}</button></section>
      <template v-else-if="record">
        <p><code>#{{ record.tool.id }} · {{ record.tool.slug }} · {{ record.tool.revision }}</code></p>
        <ConflictComparison v-if="current" :baseline="record.tool" :changes="changes" :current="current.tool" @resolve="resolve" />
        <label v-for="path in fields" :key="path" class="tool-field"><code>{{ path }}</code>
          <input v-if="path === '/isActive'" type="checkbox" :checked="value(path) === true" :disabled="locked" @change="change(path, $event)" />
          <textarea v-else :value="isJSON(path) ? rawJSON[path] ?? JSON.stringify(value(path), null, 2) : String(value(path) ?? '')"
            :readonly="locked" :rows="isJSON(path) ? 4 : 2" :aria-invalid="invalid[path]" @input="change(path, $event)" />
          <small v-if="invalid[path]" role="alert">{{ label('invalidJSON') }}</small>
        </label>
        <fieldset v-if="record.fieldPolicy.schemaPropertyRules?.length" :disabled="locked">
          <legend>{{ label('addParameter') }}</legend>
          <label class="tool-field">{{ label('schema') }}<select v-model="propertyRule" @change="selectPropertyRule">
            <option v-for="(rule, index) in record.fieldPolicy.schemaPropertyRules" :key="rule.parentPath" :value="index">{{ rule.parentPath }}</option>
          </select></label>
          <label class="tool-field">{{ label('name') }}<input v-model="propertyName" maxlength="64" /></label>
          <label class="tool-field">{{ label('schemaKeyword') }}<select v-model="propertyKeyword">
            <option v-for="keyword in record.fieldPolicy.schemaPropertyRules[propertyRule]?.keywords" :key="keyword">{{ keyword }}</option>
          </select></label>
          <label class="tool-field">{{ label('jsonValue') }}<textarea v-model="propertyJSON" rows="2" /></label>
          <button type="button" :title="label('addParameter')" :aria-label="label('addParameter')" @click="addProperty"><Plus :size="18" /></button>
        </fieldset>
        <dl><template v-for="path in record.fieldPolicy.readOnlyPaths" :key="path"><dt><code>{{ path }}</code></dt><dd>{{ record.fieldPolicy.reasons[path] || label('readonly') }}</dd></template>
          <template v-for="path in record.fieldPolicy.protectedPaths" :key="path"><dt><code>{{ path }}</code></dt><dd>{{ label('protectedReason') }}</dd></template>
          <template v-for="field in record.fieldPolicy.unknownPaths" :key="field.path"><dt><code>{{ field.path }} ({{ field.type }})</code></dt><dd>{{ label('unknownReason') }}</dd></template></dl>
        <label v-if="record.capabilities.write" class="check"><input v-model="acknowledged" type="checkbox" :disabled="locked" />{{ label('globalAck') }}</label>
        <p v-else>{{ label('readonlyResources') }}</p>
      </template>
    </div>
    <footer><button type="button" :disabled="busy" :title="label('refresh')" :aria-label="label('refresh')" @click="refresh"><RefreshCw :size="18" /><span v-if="uncertain">{{ label('queryResult') }}</span></button>
      <button v-if="record?.capabilities.write" type="button" class="primary" :disabled="locked || !dirty || !acknowledged || !!current || Object.values(invalid).some(Boolean)" @click="save"><Save :size="18" />{{ label('save') }}</button></footer>
  </dialog>
</template>

<style scoped src="./drawer.css"></style>
<style scoped>
.tool-field { display: grid; gap: 8px; margin: 20px 0; min-width: 0; }
dt { margin-top: 12px; } dd { margin: 4px 0; font-size: 12px; color: var(--text-secondary, GrayText); }
</style>

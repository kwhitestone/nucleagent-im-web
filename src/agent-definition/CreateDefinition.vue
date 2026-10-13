<script setup lang="ts">
import { trapDialogFocus } from "./focus";
import { computed, nextTick, onMounted, onUnmounted, reactive, ref } from "vue";
import { useI18n } from "vue-i18n";
import { X, Plus, RefreshCw } from "@lucide/vue";
import DefinitionFields from "./DefinitionFields.vue";
import SkillPicker from "./SkillPicker.vue";
import { CreationDraft } from "./creation";
import { buildChanges, reconcileBindings, validateChanges } from "./draft";
import type { Catalog, DefinitionApi, Detail } from "./api";
import { text, type MessageKey } from "./messages";

const props = defineProps<{ api: DefinitionApi; catalog: Catalog }>();
const emit = defineEmits<{ close: []; created: [detail: Detail] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const draft = reactive(new CreationDraft(crypto.randomUUID()));
const dialog = ref<HTMLDialogElement>();
const previousFocus = document.activeElement as HTMLElement | null;
const discard = ref(false);
const catalogError = ref(false);
const models = ref<Awaited<ReturnType<DefinitionApi["models"]>>>([]);
const backends = ref<Awaited<ReturnType<DefinitionApi["backends"]>>>([]);
let mounted = true;
const changes = computed(() => ({ ...draft.changes, "/slug": draft.slug }));
const errors = computed(() => validateChanges({}, { "/name": "", ...changes.value }));
const locked = computed(() => draft.busy || draft.frozen || draft.denied);
const providerChoices = computed(() => [...new Set(models.value.map(m => m.providerId))].map(id => ({ value: id, label: String(id) })));
const modelChoices = computed(() => models.value.filter(m => m.providerId === draft.changes["/config/defaults/providerId"]).map(m => ({ value: m.model, label: m.model })));
function change(path: string, value: unknown) {
  if (locked.value) return;
  if (path === "/slug") { draft.slug = String(value); return; }
  draft.changes = buildChanges({}, { ...draft.changes, [path]: value }, props.catalog.fieldPolicy.editablePaths);
  if (path === "/config/defaults/providerId") draft.changes["/config/defaults/model"] = "";
}
function bind(id: number, checked: boolean) {
  if (locked.value) return;
  const ids = (draft.bindings ?? []).map(b => b.skillId).filter(value => value !== id);
  if (checked) ids.push(id);
  draft.bindings = reconcileBindings([], ids, props.catalog.skills.map(s => ({ skillId: s.id, installPath: s.defaultInstallPath ?? "" })));
}
async function submit(lookup = false) {
  const saved = await (lookup ? draft.lookup(props.api) : draft.submit(props.api, props.catalog));
  if (mounted && saved) emit("created", saved);
}
function close() {
  if (draft.busy || draft.frozen) return;
  if (draft.slug || Object.keys(draft.changes).length || draft.bindings?.length) discard.value = true;
  else emit("close");
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (!draft.completed && (draft.slug || Object.keys(draft.changes).length)) { event.preventDefault(); event.returnValue = ""; }
}
onMounted(async () => {
  dialog.value?.showModal();
  window.addEventListener("beforeunload", beforeUnload);
  const results = await Promise.allSettled([props.api.models(), props.api.backends()]);
  if (!mounted) return;
  if (results[0].status === "fulfilled") models.value = results[0].value;
  if (results[1].status === "fulfilled") backends.value = results[1].value;
  catalogError.value = results.some(r => r.status === "rejected");
});
onUnmounted(() => {
  mounted = false; window.removeEventListener("beforeunload", beforeUnload);
  dialog.value?.close(); void nextTick(() => previousFocus?.isConnected && previousFocus.focus());
});
</script>

<template>
  <dialog ref="dialog" class="definition-drawer" aria-labelledby="create-definition-title" @cancel.prevent="close" @keydown="trapDialogFocus">
    <header><h2 id="create-definition-title">{{ label('create') }}</h2>
      <button type="button" class="icon" :disabled="draft.busy || draft.frozen" :aria-label="label('close')" :title="label('close')" @click="close"><X :size="20" /></button></header>
    <div class="drawer-body">
      <p class="new-note">{{ label('newNote') }}</p>
      <p v-if="draft.error" role="alert">{{ label(draft.error as MessageKey) }}</p>
      <section v-if="discard" role="alertdialog" :aria-label="label('discard')">
        <h3>{{ label('discard') }}</h3>
        <button type="button" @click="discard = false">{{ label('keepEditing') }}</button>
        <button type="button" @click="emit('close')">{{ label('discardChanges') }}</button>
      </section>
      <template v-else>
        <p v-if="catalogError" role="status">{{ label('catalogError') }}</p>
        <DefinitionFields :baseline="{}" :changes="changes" :editable-paths="locked ? [] : [...catalog.fieldPolicy.editablePaths, '/slug']"
          :readonly-fields="[]" :backends="backends.map(b => ({ value: b.id, label: b.displayName }))"
          :providers="providerChoices" :models="modelChoices" :busy="locked" @change="change" />
        <fieldset v-if="catalog.capabilities.readSkills"><legend>{{ label('skills') }}</legend>
          <SkillPicker :skills="catalog.skills" :selected="(draft.bindings ?? []).map(b => b.skillId)" :editable="!locked && catalog.capabilities.writeSkillBindings" @toggle="bind" />
        </fieldset>
      </template>
    </div>
    <footer>
      <button v-if="draft.uncertain" type="button" :disabled="draft.busy" @click="submit(true)"><RefreshCw :size="18" />{{ label('queryResult') }}</button>
      <button v-else type="button" class="primary" :disabled="draft.busy || draft.denied || !catalog.capabilities.create || !!Object.keys(errors).length" @click="submit()"><Plus :size="18" />{{ label(draft.busy ? 'saving' : 'create') }}</button>
    </footer>
  </dialog>
</template>

<style scoped src="./theme.css"></style>
<style scoped src="./drawer.css"></style>

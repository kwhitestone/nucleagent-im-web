<script setup lang="ts">
import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { definitionFields, readPath, validateChanges, type Changes } from "./draft";
import { text, type MessageKey } from "./messages";

export interface Choice { value: string | number; label: string }
export interface ReadonlyField { path: string; type: string; reason: string; value?: unknown; hidden?: boolean }
const props = defineProps<{
  baseline: unknown;
  changes: Changes;
  editablePaths: string[];
  readonlyFields: ReadonlyField[];
  backends: Choice[];
  providers: Choice[];
  models: Choice[];
  busy?: boolean;
}>();
const emit = defineEmits<{ change: [path: string, value: unknown] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const errors = computed(() => validateChanges(props.baseline, props.changes));
const value = (path: string) => Object.hasOwn(props.changes, path) ? props.changes[path] : readPath(props.baseline, path);
const allowed = (path: string) => props.editablePaths.includes(path) && !props.busy;
const id = (path: string) => `definition${path.replaceAll("/", "-")}`;
const choices = (kind: string) => kind === "backend" ? props.backends : kind === "provider" ? props.providers : props.models;
const reason = (path: string) => props.readonlyFields.find((field) => field.path === path)?.reason || label("readonly");
function change(path: string, event: Event, kind: string) {
  const target = event.target as HTMLInputElement;
  emit("change", path, kind === "boolean" ? target.checked : kind === "provider" ? (target.value ? Number(target.value) : null) : target.value);
}
function errorLabel(error: string) {
  const key = ({ slug: "slugError", avatar: "avatarError", provider: "providerError" } as Record<string, MessageKey>)[error] ?? error;
  return text(key as MessageKey, locale.value);
}
const display = (field: ReadonlyField) => field.hidden ? label("preserved")
  : field.value === undefined ? label("unknown") : typeof field.value === "string" ? field.value : JSON.stringify(field.value, null, 2);
</script>

<template>
  <div class="definition-fields">
    <div v-for="field in definitionFields" :key="field.path" class="definition-field">
      <label :for="id(field.path)">{{ label(field.label as MessageKey) }} <code>{{ field.path }}</code></label>
      <input v-if="field.kind === 'boolean'" :id="id(field.path)" type="checkbox"
        :checked="value(field.path) !== false" :disabled="!allowed(field.path)"
        :aria-describedby="`${id(field.path)}-hint`" @change="change(field.path, $event, field.kind)" />
      <textarea v-else-if="field.kind === 'textarea'" :id="id(field.path)" :value="String(value(field.path) ?? '')"
        :readonly="!allowed(field.path)" :rows="field.label === 'prompt' ? 8 : 3"
        :aria-invalid="!!errors[field.path]" :aria-describedby="`${id(field.path)}-hint`"
        @input="change(field.path, $event, field.kind)" />
      <select v-else-if="['backend', 'provider', 'model'].includes(field.kind)" :id="id(field.path)"
        :value="value(field.path) ?? ''" :disabled="!allowed(field.path)"
        :aria-invalid="!!errors[field.path]" :aria-describedby="`${id(field.path)}-hint`"
        @change="change(field.path, $event, field.kind)">
        <option value="">{{ label('inherit') }}</option>
        <option v-if="value(field.path) && !choices(field.kind).some(c => c.value === value(field.path))"
          :value="String(value(field.path))" disabled>{{ value(field.path) }} ({{ label('unavailable') }})</option>
        <option v-for="choice in choices(field.kind)" :key="choice.value" :value="choice.value">{{ choice.label }}</option>
      </select>
      <input v-else :id="id(field.path)" :value="value(field.path) ?? ''" :readonly="!allowed(field.path)"
        :aria-invalid="!!errors[field.path]" :aria-describedby="`${id(field.path)}-hint`"
        :autocomplete="field.label === 'name' ? 'off' : undefined"
        @input="change(field.path, $event, field.kind)" />
      <small :id="`${id(field.path)}-hint`" :class="{ 'definition-error': errors[field.path] }">
        <template v-if="errors[field.path]">{{ errorLabel(errors[field.path]!) }}</template>
        <template v-else-if="!props.editablePaths.includes(field.path)">{{ reason(field.path) }}</template>
        <template v-else-if="field.label === 'memory'">{{ label('memoryNote') }}</template>
        <template v-else-if="field.max">{{ [...String(value(field.path) ?? '')].length }} / {{ field.max }}</template>
      </small>
    </div>
    <details v-if="readonlyFields.length" class="definition-metadata">
      <summary>{{ label('metadata') }}</summary>
      <dl>
        <template v-for="field in readonlyFields" :key="field.path">
          <dt><code>{{ field.path }}</code> <small>{{ field.type }}</small></dt>
          <dd><pre>{{ display(field) }}</pre><small>{{ field.reason }}</small></dd>
        </template>
      </dl>
    </details>
  </div>
</template>

<style scoped>
.definition-fields { display: grid; gap: 18px; min-width: 0; }
.definition-field { display: grid; gap: 6px; min-width: 0; }
label { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; font-weight: 600; font-size: 14px; }
code, small { font-size: 12px; font-weight: 400; overflow-wrap: anywhere; color: var(--text-secondary, var(--muted, #667078)); }
input:not([type=checkbox]), textarea, select { width: 100%; box-sizing: border-box; min-width: 0; min-height: 44px; padding: 9px 10px; border: 1px solid var(--border, #adb5bd); border-radius: 4px; background: var(--bg-card, var(--panel, Canvas)); color: inherit; font: inherit; }
input[type=checkbox] { width: 24px; height: 24px; margin: 10px; accent-color: var(--accent, #16796c); }
textarea { resize: vertical; }
input[readonly], textarea[readonly] { opacity: .8; }
:focus-visible { outline: 2px solid var(--accent, #16796c); outline-offset: 3px; }
.definition-error { color: var(--danger, #c13247); }
.definition-metadata { border-top: 1px solid var(--border, #adb5bd); padding-top: 16px; }
summary { cursor: pointer; min-height: 44px; }
dl { margin: 0; } dt { margin-top: 14px; } dd { margin: 4px 0 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 4px 0; }
@media (max-width: 600px) { input, textarea, select { font-size: 16px !important; } }
</style>

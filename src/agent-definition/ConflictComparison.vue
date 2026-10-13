<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { compareChanges, definitionFields, type Changes } from "./draft";
import { text, type MessageKey } from "./messages";
const props = defineProps<{ baseline: unknown; changes: Changes; current: unknown }>();
const emit = defineEmits<{ resolve: [choices: Record<string, "mine" | "current">] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const rows = computed(() => compareChanges(props.baseline, props.changes, props.current));
const choices = reactive<Record<string, "mine" | "current">>({});
watch(() => props.current, () => { Object.keys(choices).forEach((key) => delete choices[key]); });
const resolved = computed(() => rows.value.every(row => !row.conflict || choices[row.path]));
const display = (value: unknown) => value === undefined ? label("unknown") : typeof value === "string" ? value : JSON.stringify(value);
const fieldName = (path: string) => { const field = definitionFields.find(item => item.path === path); return field ? label(field.label as MessageKey) : path; };
</script>
<template>
  <section class="definition-conflict" role="region" :aria-label="label('conflict')">
    <p role="alert" class="conflict-lead">{{ label('conflict') }}</p>
    <fieldset v-for="(row, index) in rows" :key="row.path" class="conflict-row" :style="{ animationDelay: `${Math.min(index, 8) * 50}ms` }" :data-path="row.path">
      <legend :title="row.path">{{ fieldName(row.path) }}</legend>
      <small class="before">{{ label('before') }}: {{ display(row.before) }}</small>
      <div class="conflict-options">
        <label class="conflict-option" :class="{ chosen: !row.conflict || choices[row.path] === 'mine' }">
          <input v-if="row.conflict" v-model="choices[row.path]" type="radio" :name="row.path" value="mine" />
          <span class="option-title">{{ label('mine') }}</span><span class="option-value">{{ display(row.mine) }}</span>
        </label>
        <label class="conflict-option" :class="{ chosen: choices[row.path] === 'current' }">
          <input v-if="row.conflict" v-model="choices[row.path]" type="radio" :name="row.path" value="current" />
          <span class="option-title">{{ label('current') }}</span><span class="option-value">{{ display(row.current) }}</span>
        </label>
      </div>
    </fieldset>
    <button type="button" class="apply" :disabled="!resolved" @click="emit('resolve', { ...choices })">{{ label('resolve') }}</button>
  </section>
</template>
<style scoped>
.definition-conflict { display: grid; gap: 10px; min-width: 0; }
.conflict-lead { margin: 0; font-size: 13px; color: var(--text-secondary); }
.conflict-row { min-width: 0; margin: 0; padding: 10px 12px 12px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-card); animation: fade-in-up .5s var(--ease-out) both; }
legend { font-size: 13px; font-weight: 600; padding: 0 4px; }
.before { display: block; font-size: 11.5px; color: var(--text-tertiary); margin-bottom: 8px; overflow-wrap: anywhere; }
.conflict-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.conflict-option { position: relative; display: grid; gap: 4px; align-content: start; padding: 10px 12px; min-height: 44px; border: 1.5px solid var(--border); border-radius: var(--r-md); cursor: pointer; transition: all .2s var(--ease); }
.conflict-option:hover { border-color: var(--border-strong); }
.conflict-option.chosen { border-color: var(--accent); box-shadow: var(--shadow-teal); }
.conflict-option input { position: absolute; top: 10px; right: 10px; accent-color: var(--accent); }
.option-title { font-size: 12px; font-weight: 600; color: var(--text-secondary); }
.option-value { font-size: 13px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 160px; overflow: auto; }
.apply { justify-self: end; min-height: 40px; padding: 8px 16px; border: 0; border-radius: var(--r-md); background: var(--grad-teal-indigo); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
.apply:disabled { opacity: .5; cursor: not-allowed; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 600px) { .conflict-options { grid-template-columns: 1fr; } }
@media (prefers-reduced-motion: reduce) { .conflict-row { animation: none; } }
</style>

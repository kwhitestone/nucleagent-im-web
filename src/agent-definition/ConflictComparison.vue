<script setup lang="ts">
import { computed, reactive, watch } from "vue";
import { useI18n } from "vue-i18n";
import { compareChanges, type Changes } from "./draft";
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
</script>
<template>
  <section class="definition-conflict" role="region" :aria-label="label('conflict')">
    <p role="alert">{{ label('conflict') }}</p>
    <fieldset v-for="row in rows" :key="row.path">
      <legend><code>{{ row.path }}</code></legend>
      <dl>
        <dt>{{ label('before') }}</dt><dd>{{ display(row.before) }}</dd>
        <dt>{{ label('mine') }}</dt><dd>{{ display(row.mine) }}</dd>
        <dt>{{ label('current') }}</dt><dd>{{ display(row.current) }}</dd>
      </dl>
      <template v-if="row.conflict">
        <label><input v-model="choices[row.path]" type="radio" :name="row.path" value="mine" />{{ label('mine') }}</label>
        <label><input v-model="choices[row.path]" type="radio" :name="row.path" value="current" />{{ label('current') }}</label>
      </template>
    </fieldset>
    <button type="button" :disabled="!resolved" @click="emit('resolve', { ...choices })">{{ label('resolve') }}</button>
  </section>
</template>
<style scoped>
.definition-conflict { border-left: 3px solid var(--danger, #c13247); padding: 12px; min-width: 0; }
fieldset { min-width: 0; border: 1px solid var(--border, #adb5bd); margin: 12px 0; }
legend, dd { overflow-wrap: anywhere; white-space: pre-wrap; }
dl { display: grid; grid-template-columns: 90px minmax(0, 1fr); gap: 8px; font-size: 13px; }
dd { margin: 0; max-height: 160px; overflow: auto; }
label { display: inline-flex; align-items: center; gap: 6px; min-height: 44px; padding-right: 12px; }
button { min-height: 44px; }
</style>

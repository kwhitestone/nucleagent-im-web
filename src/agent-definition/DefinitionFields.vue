<script setup lang="ts">
import { EditorFields } from "@prism-fusion/editor-ui";
import { useDefinitionFields, type DefinitionFieldProps } from "./useDefinitionFields";
export type { Choice, ReadonlyField } from "./useDefinitionFields";
const props = defineProps<DefinitionFieldProps>();
const emit = defineEmits<{ change: [path: string, value: unknown] }>();
const { controls, update, touched, display, label } = useDefinitionFields(props, emit);
</script>

<template>
  <div class="definition-fields">
    <EditorFields :fields="controls" @change="update" @touch="touched.add($event)" />
    <details v-if="readonlyFields.length && !only?.length" class="definition-metadata">
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
.definition-fields { display: grid; gap: 16px; min-width: 0; }
.definition-field { display: grid; gap: 6px; min-width: 0; }
label { display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 10px; font-weight: 500; font-size: 12px; color: var(--text-primary); }
code, small { font-size: 12px; font-weight: 400; overflow-wrap: anywhere; color: var(--text-secondary); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.definition-error { color: var(--rose-500); }
.definition-metadata { border-top: 1px solid var(--border); padding-top: 12px; }
summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; }
dl { margin: 0; } dt { margin-top: 14px; } dd { margin: 4px 0 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; margin: 4px 0; }
</style>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";

defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement>();
const previousFocus = document.activeElement as HTMLElement | null;
function requestClose() {
  // A nested editor owns its dirty/busy dismissal policy, including Escape.
  if (dialog.value?.querySelector("dialog[open], [role='dialog'], [role='alertdialog']")) return;
  emit("close");
}
onMounted(() => dialog.value?.showModal());
onBeforeUnmount(() => { dialog.value?.close(); previousFocus?.focus?.(); });
</script>

<template>
  <dialog ref="dialog" class="management-overlay" :aria-label="label" @cancel.prevent="requestClose">
    <slot :close="requestClose" />
  </dialog>
</template>

<style scoped>
.management-overlay { position: fixed; inset: 0 0 0 auto; box-sizing: border-box; margin: 0; padding: 0; width: min(1120px, 96vw); max-width: 100%; height: 100dvh; max-height: 100dvh; overflow-y: auto; border: 0; background: var(--bg, var(--bg-page)); color: var(--text-primary, #0f172a); }
.management-overlay::backdrop { background: rgb(15 23 42 / .35); }
@media (max-width: 600px) { .management-overlay { width: 100%; } }
</style>

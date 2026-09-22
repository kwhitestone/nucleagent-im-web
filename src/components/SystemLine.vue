<script setup lang="ts">
// Errors that belong to a conversation live in that conversation's timeline,
// centred and narrow, with at most one action. They used to fire as a red toast
// in the corner, which covered the composer and never said which chain tripped.
//
// Tone is the whole point of the `calm` variant: a dropped connection heals
// itself and gets neutral grey, while 429/budget needs a human to change what
// they are doing and gets rose. Same component, different weight.
withDefaults(defineProps<{ calm?: boolean; action?: string }>(), { calm: false, action: "" });
const emit = defineEmits<{ act: [] }>();
</script>

<template>
  <p class="sysline" :class="{ calm }" :role="calm ? 'status' : 'alert'">
    <span class="sysline-text"><slot /></span>
    <button v-if="action" class="sysline-act" type="button" @click="emit('act')">
      {{ action }}
    </button>
  </p>
</template>

<script setup lang="ts">
// IM1 (Q3 D3): a conversation-list avatar. People and agents draw their
// resolved https avatar (names.ts, one batched resolve per page — this
// component never fetches); no avatar, or one that failed, is the initial.
// Groups have no avatar field: their name's initial on a tint fixed per group id.
import { computed } from "vue";
import { avatarFailed, avatarSrc } from "../names";

const props = withDefaults(defineProps<{
  /** Person/agent: the IM uid. Group: the WuKong channel id (only seeds the tint). */
  id: string;
  name: string;
  kind?: "person" | "agent" | "group";
  /** The name is still resolving: neutral placeholder, no image. */
  unnamed?: boolean;
}>(), { kind: "person", unnamed: false });

const tints = ["--grad-teal-indigo", "--grad-violet-fuchsia", "--grad-amber-rose", "--grad-cyan-teal", "--grad-emerald-cyan", "--grad-brand"];

const src = computed(() => props.kind === "group" || props.unnamed ? "" : avatarSrc(props.id));
const initial = computed(() => [...props.name][0]?.toUpperCase() || "");
const tint = computed(() => {
  if (props.kind !== "group") return undefined;
  let hash = 0;
  for (const char of props.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { background: `var(${tints[hash % tints.length]})` };
});

function failed(): void {
  avatarFailed(props.id, src.value);
}
</script>

<template>
  <span class="avatar" :class="{ group: kind === 'group', bot: kind === 'agent', unnamed }" :style="tint">
    <img v-if="src" :src="src" alt="" loading="lazy" referrerpolicy="no-referrer" @error="failed">
    <template v-else>{{ initial }}</template>
  </span>
</template>

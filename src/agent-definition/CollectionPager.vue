<script setup lang="ts">
import { ChevronLeft, ChevronRight, RotateCw } from "@lucide/vue";
import { useI18n } from "vue-i18n";
defineProps<{ page: number; total: number; hasMore: boolean; loading?: boolean; failed?: boolean }>();
defineEmits<{ page: [value: number]; retry: [] }>();
const { locale } = useI18n();
</script>

<template>
  <nav class="collection-pager" :aria-label="locale.startsWith('zh') ? '分页' : 'Pagination'" :aria-busy="loading">
    <span role="status">{{ page }} · {{ total }}</span>
    <button type="button" :disabled="loading || page <= 1" :aria-label="locale.startsWith('zh') ? '上一页' : 'Previous page'" :title="locale.startsWith('zh') ? '上一页' : 'Previous page'" @click="$emit('page', page - 1)"><ChevronLeft :size="18" /></button>
    <button type="button" :disabled="loading || !hasMore" :aria-label="locale.startsWith('zh') ? '下一页' : 'Next page'" :title="locale.startsWith('zh') ? '下一页' : 'Next page'" @click="$emit('page', page + 1)"><ChevronRight :size="18" /></button>
    <button v-if="failed" type="button" :aria-label="locale.startsWith('zh') ? '重试' : 'Retry'" :title="locale.startsWith('zh') ? '重试' : 'Retry'" @click="$emit('retry')"><RotateCw :size="18" /></button>
    <span v-if="failed" role="alert">{{ locale.startsWith('zh') ? '加载失败' : 'Load failed' }}</span>
  </nav>
</template>

<style scoped>
.collection-pager { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; min-height: 44px; color: var(--text-secondary); font-size: 13px; }
button { display: grid; place-items: center; width: 36px; height: 36px; flex: 0 0 36px; background: var(--bg-card); color: var(--text-primary); border: 1px solid var(--border); border-radius: var(--r-sm); cursor: pointer; }
button:disabled { opacity: .45; cursor: default; }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
</style>

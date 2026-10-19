<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { Plus, X, Search, Sparkles } from "@lucide/vue";
import type { Skill, DefinitionApi } from "./api";
import { useRemotePage } from "./useRemotePage";
import CollectionPager from "./CollectionPager.vue";
import { text, type MessageKey } from "./messages";

const props = defineProps<{ skills: Skill[]; selected: number[]; editable: boolean; installPath?: (id: number) => string; fetchPage: DefinitionApi["skillsPage"] }>();
const emit = defineEmits<{ toggle: [skillId: number, checked: boolean]; metadata: [skills: Skill[]] }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const open = ref(false);
const { rows: matches, query, page, total, hasMore, loading, failed, go, load } =
  useRemotePage<Skill>((params, signal) => props.fetchPage(params, signal));
const selectedPage = useRemotePage<Skill>(async (params, signal) => {
  const ids = props.selected.slice((params.page - 1) * params.pageSize, params.page * params.pageSize);
  const result = await props.fetchPage({ ...params, page: 1, ids: ids.length ? ids : [0] }, signal);
  // Missing or inaccessible metadata must not hide selected IDs that can still be removed.
  return { ...result, page: params.page, total: props.selected.length,
    hasMore: params.page * params.pageSize < props.selected.length };
});
const known = ref<Skill[]>([]);
watch(matches, rows => {
  known.value = [...new Map([...known.value, ...rows].map(row => [row.id, row])).values()]
    .filter(row => props.selected.includes(row.id) || rows.some(item => item.id === row.id));
  emit("metadata", known.value);
});
watch(() => props.selected, () => { void selectedPage.load(); }, { deep: true });
onMounted(() => { void load(); void selectedPage.load(); });
const search = ref<HTMLInputElement>();
const chosen = computed(() => {
  const start = (selectedPage.page.value - 1) * 20;
  return props.selected.slice(start, start + 20).map(id =>
    selectedPage.rows.value.find(row => row.id === id)
    ?? props.skills.find(row => row.id === id)
    ?? known.value.find(row => row.id === id)
    ?? { id, name: `#${id}`, slug: "", sourceSHA256: "", isActive: false });
});
async function toggleList() { open.value = !open.value; if (open.value) { await nextTick(); search.value?.focus(); } }
</script>

<template>
  <div class="skill-picker">
    <p v-if="!chosen.length" class="skill-empty"><Sparkles :size="18" aria-hidden="true" />{{ label('noSkills') }}</p>
    <ul v-else class="skill-chips">
      <li v-for="skill in chosen" :key="skill.id" class="skill-chip">
        <span class="chip-icon" aria-hidden="true"><Sparkles :size="14" /></span>
        <span class="chip-copy"><strong>{{ skill.name }}</strong><small :title="skill.sourceSHA256">{{ installPath?.(skill.id) || skill.slug }}</small></span>
        <button v-if="editable" type="button" class="chip-remove" :aria-label="`${label('removeSkill')} ${skill.name}`" :title="label('removeSkill')" @click="emit('toggle', skill.id, false)"><X :size="14" /></button>
      </li>
    </ul>
    <CollectionPager v-if="selected.length > 20 || selectedPage.failed.value" :page="selectedPage.page.value"
      :total="selected.length" :has-more="selectedPage.page.value * 20 < selected.length" :loading="selectedPage.loading.value"
      :failed="selectedPage.failed.value" @page="selectedPage.go" @retry="selectedPage.load" />
    <button v-if="editable" type="button" class="add-skill" :aria-expanded="open" @click="toggleList"><Plus :size="16" />{{ label('addSkill') }}</button>
    <div v-if="open && editable" class="skill-popover" role="group" :aria-label="label('addSkill')" @keydown.esc.stop.prevent="open = false">
      <label class="skill-search"><Search :size="16" aria-hidden="true" /><input ref="search" v-model="query" type="search" :aria-label="label('searchSkills')" :placeholder="label('searchSkills')" /></label>
      <ul class="skill-options">
        <li v-for="skill in matches" :key="skill.id">
          <label class="skill-option" :class="{ off: !skill.isActive && !selected.includes(skill.id) }">
            <input type="checkbox" :checked="selected.includes(skill.id)" :disabled="(!skill.isActive || selected.length >= 50) && !selected.includes(skill.id)"
              @change="emit('toggle', skill.id, ($event.target as HTMLInputElement).checked)" />
            <span><strong>{{ skill.name }}</strong><small>{{ !skill.isActive && !selected.includes(skill.id) ? label('skillDisabled') : `${skill.slug} · ${skill.version}` }}</small></span>
          </label>
        </li>
        <li v-if="!matches.length" class="skill-empty">{{ label('emptyResources') }}</li>
      </ul>
      <CollectionPager :page="page" :total="total" :has-more="hasMore" :loading="loading" :failed="failed" @page="go" @retry="load" />
    </div>
  </div>
</template>

<style scoped>
.skill-picker { display: grid; gap: 10px; }
.skill-chips, .skill-options { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.skill-chip { display: flex; align-items: center; gap: 8px; padding: 6px 6px 6px 10px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-card); box-shadow: var(--shadow-xs); animation: scale-in .4s var(--ease-spring) both; max-width: 100%; }
.chip-icon { display: grid; place-items: center; width: 24px; height: 24px; border-radius: var(--r-sm); background: var(--grad-teal-indigo); color: #fff; flex-shrink: 0; }
.chip-copy { display: grid; min-width: 0; } .chip-copy strong { font-size: 13px; } small { font-size: 11.5px; color: var(--text-secondary); overflow-wrap: anywhere; }
button { display: inline-flex; align-items: center; gap: 6px; font: inherit; color: inherit; cursor: pointer; background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--r-md); transition: all .2s var(--ease); }
.chip-remove { width: 32px; height: 32px; justify-content: center; border: 0; background: transparent; color: var(--text-tertiary); }
.chip-remove:hover { color: var(--rose-500); background: var(--bg-hover); }
.add-skill { justify-self: start; min-height: 40px; padding: 6px 12px; font-size: 12.5px; border-style: dashed; color: var(--accent); }
.add-skill:hover { border-color: var(--accent); background: var(--teal-50); }
.skill-popover { border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-card); box-shadow: var(--shadow-lg); padding: 10px; animation: scale-in .4s var(--ease-spring) both; transform-origin: top left; }
.skill-search { display: flex; align-items: center; gap: 8px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--r-md); margin-bottom: 8px; }
.skill-search input { border: 0; outline: 0; min-height: 40px; width: 100%; background: transparent; font: inherit; color: inherit; }
.skill-options { display: grid; max-height: 260px; overflow: auto; }
.skill-option { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: var(--r-md); cursor: pointer; min-height: 44px; }
.skill-option:hover { background: var(--bg-hover); } .skill-option.off { opacity: .55; cursor: not-allowed; }
.skill-option span { display: grid; min-width: 0; }
.skill-option input { width: 18px; height: 18px; accent-color: var(--accent); flex-shrink: 0; }
.skill-empty { display: flex; align-items: center; gap: 8px; color: var(--text-tertiary); font-size: 13px; margin: 0; padding: 8px 0; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
@media (max-width: 600px) { input { font-size: 16px !important; } }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
</style>

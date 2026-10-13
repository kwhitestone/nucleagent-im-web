<script setup lang="ts">
import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { avatarGradient, avatarUrl, initial } from "./groups";
import { text, type MessageKey } from "./messages";

const props = defineProps<{ id: number; name: string; description: string; avatar: unknown; active: boolean; deleted: boolean; model: string }>();
const { locale } = useI18n();
const label = (key: MessageKey) => text(key, locale.value);
const failed = ref("");
const src = () => { const url = avatarUrl(props.avatar); return url && url !== failed.value ? url : ""; };
</script>

<template>
  <aside class="agent-preview" :aria-label="label('preview')">
    <h3>{{ label('preview') }}</h3>
    <div class="card-preview">
      <img v-if="src()" :src="src()" alt="" class="avatar" referrerpolicy="no-referrer" @error="failed = src()" />
      <span v-else class="avatar" :style="{ background: avatarGradient(id) }" aria-hidden="true">{{ initial(name) }}</span>
      <strong>{{ name || '—' }}</strong>
      <p>{{ description }}</p>
      <div class="pills"><span class="pill" :class="deleted ? 'deleted' : active ? 'active' : 'disabled'">{{ label(deleted ? 'deleted' : active ? 'active' : 'disabled') }}</span>
        <span class="pill model">{{ model || label('inherit') }}</span></div>
    </div>
    <h3>{{ label('previewIm') }}</h3>
    <div class="chat">
      <p class="bubble user">{{ label('previewUser') }}</p>
      <div class="reply"><span class="mini" :style="{ background: avatarGradient(id) }" aria-hidden="true">{{ initial(name) }}</span>
        <div><small>{{ name }}</small><p class="bubble agent">{{ label('previewReply') }}</p></div></div>
    </div>
    <p class="note">{{ label('previewNote') }}</p>
  </aside>
</template>

<style scoped>
.agent-preview { display: grid; gap: 10px; align-content: start; }
h3 { margin: 4px 0 0; font-size: 12px; font-weight: 600; color: var(--text-tertiary); letter-spacing: .04em; }
.card-preview { display: grid; justify-items: center; gap: 8px; text-align: center; padding: 18px 14px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg-card); box-shadow: var(--shadow-sm); }
.avatar { width: 56px; height: 56px; border-radius: var(--r-lg); object-fit: cover; display: grid; place-items: center; color: #fff; font-weight: 700; font-size: 22px; }
strong { font-size: 15px; overflow-wrap: anywhere; } p { margin: 0; }
.card-preview p { font-size: 12.5px; color: var(--text-secondary); overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pills { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
.pill { font-size: 11.5px; padding: 2px 8px; border-radius: var(--r-full); background: var(--slate-100); color: var(--slate-700); }
.pill.active { background: #ecfdf5; color: #047857; } .pill.deleted { background: #fff1f2; color: #be123c; } .pill.model { background: var(--teal-50); color: var(--teal-700); }
.chat { display: grid; gap: 10px; padding: 14px; border-radius: var(--r-lg); background: var(--bg-subtle); }
.bubble { font-size: 12.5px; padding: 8px 12px; border-radius: var(--r-md); max-width: 85%; }
.user { justify-self: end; background: var(--grad-teal-indigo); color: #fff; }
.reply { display: flex; gap: 8px; align-items: flex-start; } .reply small { font-size: 11px; color: var(--text-tertiary); }
.agent { background: var(--bg-card); color: var(--text-secondary); box-shadow: var(--shadow-xs); }
.mini { width: 28px; height: 28px; border-radius: var(--r-sm); display: grid; place-items: center; color: #fff; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.note { font-size: 11.5px; color: var(--text-tertiary); }
</style>

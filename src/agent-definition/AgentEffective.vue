<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { RefreshCw } from "@lucide/vue";
import type { EffectiveApi, EffectiveDefinition, Source } from "./effective";

const props = defineProps<{ api: EffectiveApi; kind: "uid" | "instance" | "conversation"; id: number }>();
const { locale } = useI18n();
const zh = computed(() => locale.value.startsWith("zh"));
const words = computed(() => zh.value ? {
  title: "有效定义", refresh: "刷新", current: "下一轮准入", admitted: "最近已准入轮次",
  revision: "定义版本", identity: "身份版本", fingerprint: "有效版本", model: "模型来源", backend: "执行后端来源",
  prompt: "提示词来源", skills: "技能版本", tools: "工具版本", bindings: "绑定来源", executing: "参与执行",
  inactive: "不参与执行", empty: "无", loading: "正在读取", failed: "有效版本暂不可用，无法确认当前状态。",
  unavailable: "当前不可准入", none: "尚无已准入记录", stale: "当前定义不可解析或已失效",
  template: "共享定义", instance: "个人覆盖", conversation: "会话固定值", global: "全局",
} : {
  title: "Effective definition", refresh: "Refresh", current: "Next admission", admitted: "Last admitted round",
  revision: "Definition revision", identity: "Identity revision", fingerprint: "Effective revision", model: "Model source",
  backend: "Backend source", prompt: "Prompt source", skills: "Skill versions", tools: "Tool versions", bindings: "Binding sources",
  executing: "Executing", inactive: "Not executing", empty: "None", loading: "Loading",
  failed: "Effective version unavailable. Current state is unverified.", unavailable: "Admission unavailable",
  none: "No admitted round", stale: "Current definition is unresolved or invalidated",
  template: "Shared definition", instance: "Personal override", conversation: "Fixed by conversation", global: "Global",
});
const value = ref<EffectiveDefinition>();
const busy = ref(false);
const failed = ref(false);
let mounted = false;
let serial = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
const origin = (source: string) => words.value[source as Source | "global"] || source;
const versions = computed(() => value.value ? [
  { title: words.value.current, material: value.value.current, empty: words.value.unavailable },
  ...(props.kind === "conversation" ? [{ title: words.value.admitted, material: value.value.admitted, empty: words.value.none }] : []),
] : []);
async function refresh() {
  const generation = ++serial;
  clearTimeout(timer); busy.value = true;
  try {
    const fresh = await props.api[props.kind](props.id);
    if (mounted && serial === generation) { value.value = fresh; failed.value = false; }
  } catch {
    if (mounted && serial === generation) { value.value = undefined; failed.value = true; }
  } finally {
    if (mounted && serial === generation) {
      busy.value = false;
      timer = setTimeout(() => { if (document.visibilityState !== "hidden") void refresh(); }, 2000);
    }
  }
}
function visible() { if (document.visibilityState !== "hidden") void refresh(); }
watch(() => [props.kind, props.id], () => { value.value = undefined; if (mounted) void refresh(); });
onMounted(() => {
  mounted = true; void refresh();
  window.addEventListener("focus", visible); window.addEventListener("online", visible);
  document.addEventListener("visibilitychange", visible);
});
onUnmounted(() => {
  mounted = false; serial++; clearTimeout(timer);
  window.removeEventListener("focus", visible); window.removeEventListener("online", visible);
  document.removeEventListener("visibilitychange", visible);
});
</script>

<template>
  <section class="agent-effective" data-testid="agent-effective">
    <header><h2>{{ words.title }}</h2><button type="button" :disabled="busy" :title="words.refresh" :aria-label="words.refresh" @click="refresh"><RefreshCw :size="18" /></button></header>
    <p v-if="failed" role="alert">{{ words.failed }}</p>
    <p v-else-if="!value" role="status">{{ words.loading }}</p>
    <template v-else>
      <p><code>Core #{{ value.definitionId }} · {{ words.revision }} {{ value.definitionRevision }}</code></p>
      <p v-if="value.stale" role="status">{{ words.stale }}</p>
      <div class="versions">
        <section v-for="version in versions" :key="version.title">
          <h3>{{ version.title }}</h3>
          <p v-if="!version.material">{{ version.empty }}</p>
          <dl v-else>
            <dt>{{ words.revision }}</dt><dd>{{ version.material.definitionRevision }}</dd>
            <dt>{{ words.identity }}</dt><dd>{{ version.material.identityRevision }}</dd>
            <dt>{{ words.fingerprint }}</dt><dd><code>{{ version.material.effectiveRevision }}</code></dd>
            <dt>{{ words.model }}</dt><dd>{{ origin(version.material.modelSource) }}</dd>
            <dt>{{ words.backend }}</dt><dd>{{ origin(version.material.backendSource) }}</dd>
            <dt>{{ words.prompt }}</dt><dd>{{ version.material.promptSources.map(origin).join(' + ') }}</dd>
            <dt>{{ words.skills }}</dt><dd><span v-for="skill in version.material.skills" :key="skill.id">#{{ skill.id }} · R{{ skill.revision }} · {{ origin(skill.source) }}</span><span v-if="!version.material.skills.length">{{ words.empty }}</span></dd>
            <dt>{{ words.tools }}</dt><dd><span v-for="tool in version.material.tools" :key="tool.id">#{{ tool.id }} · R{{ tool.revision }} · {{ origin(tool.source) }}</span><span v-if="!version.material.tools.length">{{ words.empty }}</span></dd>
            <dt>{{ words.bindings }}</dt><dd><span v-for="binding in version.material.bindings" :key="binding.id">#{{ binding.skillId }} · {{ origin(binding.source) }} · {{ binding.executing ? words.executing : words.inactive }}</span><span v-if="!version.material.bindings.length">{{ words.empty }}</span></dd>
          </dl>
        </section>
      </div>
    </template>
  </section>
</template>

<style scoped>
.agent-effective { padding: 16px 0; border-block: 1px solid var(--border); color: var(--text-primary, CanvasText); min-width: 0; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px; } h2 { font-size: 16px; margin: 0; } h3 { font-size: 14px; }
button { width: 44px; height: 44px; display: grid; place-items: center; background: transparent; color: inherit; border: 1px solid var(--border); border-radius: 4px; cursor: pointer; }
button:focus-visible { outline: 2px solid var(--accent, #16796c); outline-offset: 2px; }
.versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 270px), 1fr)); gap: 24px; }
dl { display: grid; grid-template-columns: minmax(85px, 1fr) minmax(0, 2fr); gap: 10px; font-size: 12px; }
dt { color: var(--text-secondary, GrayText); } dd { margin: 0; } dd span { display: block; }
p, dd, code { overflow-wrap: anywhere; } p { font-size: 13px; }
</style>

<script setup lang="ts">
// First-run guidance. A new user used to land on a blank list reading
// "No recent conversations", with three equally-weighted controls above it and
// nothing saying which to use first.
//
// Deliberately a numbered vertical list with one primary, NOT three equal
// tiles: a feature-tile grid is marketing composition, and on an operating
// surface it pushes the choice back onto the user when the three paths are not
// actually equal — search is the main road.
//
// Each line says WHEN to use it, not just what it is called.
import { useI18n } from "vue-i18n";

const emit = defineEmits<{ search: []; dial: []; group: [] }>();
const { t } = useI18n();
</script>

<template>
  <div class="empty-paths">
    <h2>{{ t("empty.noConversations") }}</h2>
    <p>{{ t("empty.noConversationsSub") }}</p>

    <div class="paths">
      <button class="path primary" type="button" @click="emit('search')">
        <span class="path-key">1</span>
        <span class="path-copy">
          <b>{{ t("empty.pathSearch") }}</b>
          <small>{{ t("empty.pathSearchSub") }}</small>
        </span>
      </button>
      <button class="path" type="button" @click="emit('dial')">
        <span class="path-key">2</span>
        <span class="path-copy">
          <b>{{ t("empty.pathUid") }}</b>
          <small>{{ t("empty.pathUidSub") }}</small>
        </span>
      </button>
      <!-- The third line also teaches the one product rule the UI never stated:
           @-mentioning an agent only works inside a group. -->
      <button class="path" type="button" @click="emit('group')">
        <span class="path-key">3</span>
        <span class="path-copy">
          <b>{{ t("empty.pathGroup") }}</b>
          <small>{{ t("empty.pathGroupSub") }}</small>
        </span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
// The gap this closes: session.uid existed only in memory and was used solely to
// decide message ownership — the UI never rendered it, so a user could not find
// their own ID to share. It now sits in the rail's user slot (the same place the
// shell puts its user chip) and expands into a profile popover.
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { toggleLocale } from "../i18n";

const props = defineProps<{
  uid: string;
  /** Empty until a profile is resolved; falls back to "Portal user <uid>". */
  displayName?: string;
}>();

const emit = defineEmits<{ logout: [] }>();

const { t } = useI18n();
const open = ref(false);
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | undefined;

const name = computed(() => props.displayName?.trim() || `Portal user ${props.uid}`);
const initial = computed(() => [...name.value][0]?.toUpperCase() || "?");

async function copyUid(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.uid);
  } catch {
    // Clipboard is permission-gated and absent over plain HTTP. Selecting the
    // UID by hand still works, so a refused copy must not throw a dialog at
    // someone who can simply read the number that is already on screen.
    return;
  }
  // Feedback lands in place rather than as a toast: a toast is for things that
  // happen where you are not looking, and the user is looking right at this.
  copied.value = true;
  clearTimeout(copyTimer);
  copyTimer = setTimeout(() => {
    copied.value = false;
  }, 2000);
}

onBeforeUnmount(() => clearTimeout(copyTimer));
</script>

<template>
  <div class="identity">
    <button
      class="identity-chip"
      type="button"
      :aria-label="t('me.openProfile')"
      :aria-expanded="open"
      @click="open = !open"
    >
      <span class="avatar round">{{ initial }}</span>
    </button>

    <div v-if="open" class="identity-pop" role="dialog" :aria-label="t('me.openProfile')">
      <div class="identity-head">
        <span class="avatar round lg">{{ initial }}</span>
        <span class="identity-name">
          <strong>{{ name }}</strong>
          <small>{{ t("me.enterpriseAccount") }}</small>
        </span>
      </div>

      <!-- UID on its own row, mono, with a copy key: a digit string mixed into
           body type cannot be checked digit by digit. -->
      <div class="identity-uid">
        <span class="uid-label">{{ t("badge.uid") }}</span>
        <span class="uid-value">{{ uid }}</span>
        <button class="quiet uid-copy" type="button" @click="copyUid">
          {{ copied ? t("me.copied") : t("me.copy") }}
        </button>
      </div>
      <!-- Without this line a user knows the UID exists but not what it is for. -->
      <p class="identity-hint">{{ t("me.shareHint") }}</p>

      <div class="identity-actions">
        <button class="quiet" type="button" @click="toggleLocale">{{ t("me.language") }}</button>
        <button class="quiet" type="button" @click="emit('logout')">{{ t("login.signOut") }}</button>
      </div>
    </div>
  </div>
</template>

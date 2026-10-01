<script setup lang="ts">
// The rail's user slot (same place the shell puts its user chip). Clicking it
// opens the shell-owned AccountPopover (UNI-ACCTUI): name, avatar, UID copy,
// Manage account, Sign out — one implementation for every site, loaded at
// runtime from the shell. If that load fails the card degrades to avatar + name
// only, with no actions, and never shows an error.
import { computed, onBeforeUnmount, ref } from "vue";
import { useI18n } from "vue-i18n";
import { useAccountPopover } from "../accountPopover";
import { getLocale } from "../i18n";
import { accountTypeOf, handleFor, isEnterprise, openIdOf, phoneMaskedOf } from "../names";

const props = defineProps<{
  uid: string;
  /** Empty until a profile is resolved; a skeleton shows meanwhile, never the UID. */
  displayName?: string;
  /** auth user-info headerImg; the popover shows only absolute http(s) URLs. */
  avatar?: string;
}>();

const emit = defineEmits<{ account: []; logout: [] }>();

const { t } = useI18n();
const popover = useAccountPopover();
/** The degraded card's disclosure; the popover manages its own. */
const open = ref(false);
const chip = ref<HTMLElement>();

const name = computed(() => props.displayName?.trim() || "");
const initial = computed(() => [...name.value][0]?.toUpperCase() || "");

async function onClick(): Promise<void> {
  if (open.value) {
    open.value = false;
    return;
  }
  const shown = chip.value && await popover.open(chip.value, {
    user: {
      nickName: props.displayName?.trim() ?? "", headerImg: props.avatar ?? "", uid: props.uid,
      // Self is in the resolve batch, so the unified card's rows (UNI-PROFILE1) need no extra call.
      username: handleFor(props.uid) || undefined, accountType: accountTypeOf(props.uid), enterprise: isEnterprise(props.uid),
      openId: openIdOf(props.uid),
      // UNI-PHONESEARCH: masked like everyone else's; the portal shows the full one.
      phoneMasked: phoneMaskedOf(props.uid),
    },
    locale: getLocale(),
    manageAccount: () => emit("account"),
    logout: () => emit("logout"),
  });
  if (!shown) open.value = true;
}

onBeforeUnmount(() => popover.close());
</script>

<template>
  <div class="identity">
    <button
      ref="chip"
      class="identity-chip"
      type="button"
      data-testid="im-identity-chip"
      :aria-label="t('me.openProfile')"
      @click="onClick"
    >
      <span class="avatar round">{{ initial }}</span>
      <span class="rail-label">{{ t("tab.me") }}</span>
    </button>

    <!-- Degraded (account-ui unavailable): avatar + name only, no actions. -->
    <div v-if="open" class="identity-pop" role="dialog" data-testid="im-identity-fallback" :aria-label="t('me.openProfile')">
      <div class="identity-head">
        <span class="avatar round lg">{{ initial }}</span>
        <span class="identity-name">
          <strong v-if="name">{{ name }}</strong>
          <strong v-else class="name-skeleton" :aria-label="t('chat.loading')" />
        </span>
      </div>
    </div>
  </div>
</template>

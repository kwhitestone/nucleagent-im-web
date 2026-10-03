<script setup lang="ts">
// The rail's user slot (same place the shell puts its user chip). Clicking it
// opens the shell-owned AccountPopover (UNI-ACCTUI): name, avatar, UID copy,
// Manage account, Sign out — one implementation for every site, loaded at
// runtime from the shell. If that load fails the card degrades to avatar + name
// only, with no actions, and never shows an error.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { useAccountPopover } from "../accountPopover";
import { authBase } from "../api";
import { getLocale } from "../i18n";
import { accountTypeOf, handleFor, isEnterprise, openIdOf, phoneMaskedOf } from "../names";

const props = defineProps<{
  uid: string;
  /** Empty until a profile is resolved; a skeleton shows meanwhile, never the UID. */
  displayName?: string;
  /** auth user-info headerImg; the popover shows only absolute http(s) URLs. */
  avatar?: string;
  /** user-info roles: the same Roles row the shell's self card shows (UNI-CARDCONT). */
  roles?: string[];
  /** Session access token: the shared avatar resolves this identity's photo from auth with it. */
  token?: string;
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
      nickName: props.displayName?.trim() ?? "", headerImg: props.avatar ?? "", uid: props.uid, roles: props.roles,
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

// UNI-AVATAR-UNIFY: the chip's avatar is the shell's one avatar control
// (account-ui `avatar`), photo resolved from auth for this session. Until it
// loads, or if account-ui is down, the initial below stays.
const avatarHost = ref<HTMLElement>();
let disposeAvatar: (() => void) | undefined;
watch(
  () => [avatarHost.value, props.uid, name.value, props.avatar, props.token] as const,
  async ([host, uid, display, url, token]) => {
    const control = await popover.avatar();
    if (!control || !host || host !== avatarHost.value) return;
    disposeAvatar?.();
    disposeAvatar = control.mount(host, {
      name: display, avatarUrl: url, uid, openId: openIdOf(uid) || undefined,
      auth: token ? { base: authBase, token } : undefined,
    });
  },
  { immediate: true, flush: "post" },
);

onBeforeUnmount(() => {
  disposeAvatar?.();
  popover.close();
});
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
      <span ref="avatarHost" class="avatar round" data-testid="im-identity-avatar">{{ initial }}</span>
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

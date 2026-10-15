<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  addGroupMembers,
  createGroup,
  deleteGroup,
  getAgentAllowlist,
  getGroupMembers,
  removeGroupMember,
  replaceAgentAllowlist,
  type AgentAllowlist,
  type ConnectSession,
  type Contact,
  type GroupMember,
  type IMGroup,
} from "../api";
import { useI18n } from "vue-i18n";
import ContactPicker from "./ContactPicker.vue";
import { avatarFor, ensureNames, handleFor, nameFor } from "../names";
import type { DirectoryAgent } from "../agents";
import { useAccountPopover, type ProfileTarget } from "../accountPopover";

const props = defineProps<{
  session: ConnectSession;
  group?: IMGroup;
  directoryAgents?: DirectoryAgent[];
  /** Create mode: people already picked (the profile card's "Add to group"). */
  preselect?: Contact[];
}>();

const emit = defineEmits<{
  close: [];
  created: [group: IMGroup];
  changed: [];
  removed: [group: IMGroup];
  /** A member row was clicked: show their profile card. */
  profile: [anchor: HTMLElement, target: ProfileTarget];
}>();

const { t } = useI18n();

const title = ref("");
const selected = ref<Contact[]>([...(props.preselect ?? [])]);
const members = ref<GroupMember[]>([]);
const allowlists = ref<Record<number, AgentAllowlist>>({});
const allowlistDrafts = ref<Record<number, number[]>>({});
/** Per-agent failure of the last Save (agent uid → message); those drafts stay unsaved. */
const saveErrors = ref<Record<number, string>>({});
const loading = ref(false);
const saving = ref(false);
const error = ref("");
/** One view at a time in the body: the picker replaces the member list, never stacks on it. */
const view = ref<"members" | "add">("members");
/** The member whose "Remove" is armed; only the inline confirm deletes. */
const removing = ref<number>();
/** Where a member's card renders: the panel's own area above the list, so it never covers a row (G2). */
const cardHost = ref<HTMLElement>();

const isOwner = computed(() => props.group?.creatorUid === Number(props.session.uid));
const agents = computed(() => members.value.filter((member) => member.accountType === "agent"));
const allowlistCandidates = computed(() =>
  members.value.filter((member) =>
    member.accountType === "human" && member.uid !== props.group?.creatorUid,
  ),
);

async function load(): Promise<void> {
  if (!props.group) return;
  loading.value = true;
  error.value = "";
  try {
    const data = await getGroupMembers(props.group.id, props.session);
    members.value = data.members;
    void ensureNames(data.members.map((member) => String(member.uid)), props.session);
    if (isOwner.value) {
      const entries = await Promise.all(
        data.members
          .filter((member) => member.accountType === "agent")
          .map((agent) => getAgentAllowlist(props.group!.id, agent.uid, props.session)),
      );
      allowlists.value = Object.fromEntries(entries.map((entry) => [entry.agentUid, entry]));
      allowlistDrafts.value = Object.fromEntries(
        entries.map((entry) => [entry.agentUid, [...entry.memberUids]]),
      );
    }
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errLoad");
  } finally {
    loading.value = false;
  }
}

watch(() => props.group?.id, () => void load(), { immediate: true });

async function create(): Promise<void> {
  if (!title.value.trim() || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const group = await createGroup(
      title.value.trim(),
      selected.value.map((contact) => contact.id),
      props.session,
    );
    emit("created", group);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errCreate");
  } finally {
    saving.value = false;
  }
}

async function addMembers(): Promise<void> {
  if (!props.group || !selected.value.length || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await addGroupMembers(
      props.group.id,
      selected.value.map((contact) => contact.id),
      props.session,
    );
    selected.value = [];
    view.value = "members";
    await load();
    emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errMembers");
  } finally {
    saving.value = false;
  }
}

async function removeMember(member: GroupMember): Promise<void> {
  if (!props.group || saving.value) return;
  removing.value = undefined;
  saving.value = true;
  error.value = "";
  try {
    await removeGroupMember(props.group.id, member.uid, props.session);
    await load();
    emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errMembers");
  } finally {
    saving.value = false;
  }
}

async function leave(): Promise<void> {
  if (!props.group || saving.value) return;
  if (!window.confirm(`${t("group.leave")} — ${props.group.title}?`)) return;
  saving.value = true;
  try {
    await removeGroupMember(props.group.id, Number(props.session.uid), props.session);
    emit("removed", props.group);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errSave");
  } finally {
    saving.value = false;
  }
}

async function destroy(): Promise<void> {
  if (!props.group || saving.value) return;
  if (!window.confirm(`${t("group.delete")} — ${props.group.title}?`)) return;
  saving.value = true;
  try {
    await deleteGroup(props.group.id, props.session);
    emit("removed", props.group);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errSave");
  } finally {
    saving.value = false;
  }
}

function toggleAllowlist(agentUid: number, memberUid: number): void {
  const current = allowlistDrafts.value[agentUid] || [];
  allowlistDrafts.value = {
    ...allowlistDrafts.value,
    [agentUid]: current.includes(memberUid)
      ? current.filter((uid) => uid !== memberUid)
      : [...current, memberUid],
  };
}

const sameUids = (a: number[], b: number[]) => a.length === b.length && a.every((uid) => b.includes(uid));

/**
 * The footer's one Save writes only the agents this panel changed: the backend
 * replaces a whole list, so resending an untouched agent's open-time snapshot
 * would undo an edit made elsewhere meanwhile. People who left since the panel
 * opened are dropped first (the backend 404s a list naming them). Each agent
 * stands alone: a failure keeps that agent's draft and error, the rest still
 * save, and Save again retries only what is still unsaved. The checkboxes stay
 * live during a Save; an edit made meanwhile is not overwritten by the response.
 */
async function saveAllowlists(): Promise<void> {
  if (!props.group || saving.value) return;
  const group = props.group;
  const dirty = agents.value.filter((agent) =>
    !sameUids(allowlistDrafts.value[agent.uid] ?? [], allowlists.value[agent.uid]?.memberUids ?? []));
  saveErrors.value = {};
  error.value = "";
  if (!dirty.length) return;
  saving.value = true;
  try {
    members.value = (await getGroupMembers(group.id, props.session)).members;
    const present = new Set(members.value.map((member) => member.uid));
    const errors: Record<number, string> = {};
    for (const agent of dirty.filter((item) => present.has(item.uid))) {
      const sent = allowlistDrafts.value[agent.uid];
      try {
        const saved = await replaceAgentAllowlist(
          group.id,
          agent.uid,
          sent.filter((uid) => present.has(uid)),
          props.session,
        );
        allowlists.value = { ...allowlists.value, [agent.uid]: saved };
        // A tick made while this PUT was in flight is newer than the response: keep it (unsaved).
        if (sameUids(allowlistDrafts.value[agent.uid], sent)) {
          allowlistDrafts.value = { ...allowlistDrafts.value, [agent.uid]: [...saved.memberUids] };
        }
      } catch (cause) {
        errors[agent.uid] = cause instanceof Error ? cause.message : t("group.errSave");
      }
    }
    saveErrors.value = errors;
    const failed = dirty.filter((agent) => errors[agent.uid]).map(memberName);
    if (failed.length) error.value = t("group.errSaveAgents", { agents: failed.join(", ") });
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : t("group.errSave");
  } finally {
    saving.value = false;
  }
}

// Same naming rule as the conversation list: resolved nickName first.
function memberName(member: GroupMember): string {
  return nameFor(String(member.uid), member.displayName, member.username)
    || member.displayName || member.username;
}

function inspect(member: GroupMember, anchor: HTMLElement): void {
  emit("profile", anchor, {
    uid: String(member.uid),
    known: {
      nickName: memberName(member), username: member.username, avatar: member.avatar,
      accountType: member.accountType, provisioned: true,
    },
    host: cardHost.value,
  });
}

/** Back to the member list; unconfirmed picks are dropped (Cancel and Esc alike). */
function leavePicker(): void {
  view.value = "members";
  selected.value = [];
}

// Esc steps back one layer: an armed remove, then the picker view, then the
// panel. A layer above that already took the key (the shared profile card, the
// picker's open list) marks it handled.
function onKey(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented) return;
  if (removing.value !== undefined) removing.value = undefined;
  else if (view.value === "add") leavePicker();
  else emit("close");
}

onMounted(() => window.addEventListener("keydown", onKey));
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKey);
  // The member card belongs to this panel: it does not outlive it over the chat.
  useAccountPopover().close();
});
</script>

<template>
  <div class="dialog-backdrop" role="presentation" @mousedown.self="$emit('close')">
    <section
      class="group-dialog"
      role="dialog"
      aria-modal="true"
      :aria-label="group ? group.title : t('group.create')"
    >
      <header class="dialog-header">
        <div>
          <h2>{{ group ? group.title : t("group.create") }}</h2>
          <span v-if="group">{{
            t("chat.groupMeta", {
              people: members.length - agents.length,
              agents: agents.length,
            })
          }}</span>
        </div>
        <button
          class="icon-button"
          type="button"
          :aria-label="t('group.close')"
          :title="t('group.close')"
          @click="$emit('close')"
        >×</button>
      </header>

      <form v-if="!group" class="dialog-body form-stack" @submit.prevent="create">
        <label>
          {{ t("group.name") }}
          <input v-model="title" maxlength="255" required autofocus>
        </label>
        <ContactPicker
          v-model="selected"
          :session="session"
          :agents="directoryAgents"
          multiple
          :label="t('group.members')"
          :placeholder="t('group.searchMembers')"
          :exclude-uids="[Number(session.uid)]"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" type="submit" :disabled="saving || !title.trim()">
          {{ saving ? t("chat.loading") : t("group.create") }}
        </button>
      </form>

      <template v-else>
        <div ref="cardHost" class="group-card-host" data-testid="im-group-card-host" />
        <div class="dialog-body" data-testid="im-group-body">
          <p v-if="loading" class="loading">{{ t("chat.loading") }}</p>
          <p v-if="error" class="error" role="alert">{{ error }}</p>

          <section v-if="!loading && view === 'add'" class="group-section">
            <h3>{{ t("group.addMembers") }}</h3>
            <ContactPicker
              v-model="selected"
              :session="session"
              :agents="directoryAgents"
              multiple
              :placeholder="t('group.searchMembers')"
              :exclude-uids="members.map((member) => member.uid)"
            />
          </section>

          <template v-else-if="!loading">
            <section class="group-section">
              <div class="group-section-head">
                <h3>{{ t("group.members") }}</h3>
                <button v-if="isOwner" class="quiet" type="button" data-testid="im-group-add" :disabled="saving" @click="view = 'add'">
                  {{ t("group.addMembers") }}
                </button>
              </div>
              <div class="member-list">
                <div v-for="member in members" :key="member.uid" class="member-row">
                  <div class="member-identity">
                    <button
                      class="member-name"
                      type="button"
                      data-testid="im-member-profile"
                      :aria-label="t('profile.view', { name: memberName(member) })"
                      @click="inspect(member, $event.currentTarget as HTMLElement)"
                    >
                      <span class="avatar member-avatar" :class="{ bot: member.accountType === 'agent' }">
                        <img v-if="avatarFor(String(member.uid), member.avatar)" :src="avatarFor(String(member.uid), member.avatar)" alt="" referrerpolicy="no-referrer">
                        <template v-else>{{ [...memberName(member)][0]?.toUpperCase() }}</template>
                      </span>
                      <span class="member-label">{{ memberName(member) }}</span>
                    </button>
                    <span v-if="member.accountType === 'agent'" class="tag agent" data-testid="im-member-agent-badge">{{ t("badge.agent") }}</span>
                    <small>
                      {{ member.accountType === "agent" ? ""
                        : handleFor(String(member.uid), member.username) ? `@${handleFor(String(member.uid), member.username)}` : t("badge.person") }}
                      <template v-if="member.uid === group.creatorUid">· {{ t("group.owner") }}</template>
                    </small>
                  </div>
                  <template v-if="isOwner && member.uid !== group.creatorUid">
                    <span v-if="removing === member.uid" class="remove-confirm">
                      <button class="quiet" type="button" :disabled="saving" @click="removing = undefined">
                        {{ t("hide.cancel") }}
                      </button>
                      <button
                        class="quiet danger-text"
                        type="button"
                        data-testid="im-member-remove-confirm"
                        :disabled="saving"
                        @click="removeMember(member)"
                      >{{ t("group.removeConfirm") }}</button>
                    </span>
                    <button
                      v-else
                      class="quiet danger-text"
                      type="button"
                      data-testid="im-member-remove"
                      :disabled="saving"
                      @click="removing = member.uid"
                    >{{ t("group.remove") }}</button>
                  </template>
                </div>
              </div>
            </section>

            <section v-if="isOwner && agents.length" class="group-section">
              <!-- Heading was "Agent allowlists", which required the reader to
                   already know the concept. It is now the question itself, with
                   the consequence of the rule stated under the control. -->
              <div v-for="agent in agents" :key="agent.uid" class="allowlist">
                <div class="allowlist-heading">
                  <strong>{{
                    t("group.allowlistTitle", { agent: memberName(agent) })
                  }}</strong>
                </div>
                <label v-if="allowlists[agent.uid]?.ownerImplicit" class="check-row owner-row">
                  <input type="checkbox" checked disabled>
                  {{ t("group.allowlistOwner", { name: t("group.owner") }) }}
                </label>
                <label v-for="member in allowlistCandidates" :key="member.uid" class="check-row">
                  <input
                    type="checkbox"
                    :checked="allowlistDrafts[agent.uid]?.includes(member.uid)"
                    @change="toggleAllowlist(agent.uid, member.uid)"
                  >
                  {{ memberName(member) }}
                </label>
                <p v-if="saveErrors[agent.uid]" class="error" data-testid="im-allowlist-error" role="alert">
                  {{ t("group.errSave") }}: {{ saveErrors[agent.uid] }}
                </p>
                <p v-if="!allowlistCandidates.length" class="picker-status">
                  {{ t("group.allowlistEmpty") }}
                </p>
                <p class="allowlist-hint">{{ t("group.allowlistHint") }}</p>
              </div>
            </section>
          </template>
        </div>

        <!-- Outside the scroll body: Save and Dissolve stay on screen at any member count (G1). -->
        <footer v-if="!loading" class="dialog-actions" data-testid="im-group-footer">
          <template v-if="view === 'add'">
            <button class="quiet" type="button" :disabled="saving" @click="leavePicker">
              {{ t("hide.cancel") }}
            </button>
            <button class="primary" type="button" data-testid="im-group-add-confirm" :disabled="saving || !selected.length" @click="addMembers">
              {{ t("group.addMembers") }}{{ selected.length ? ` (${selected.length})` : "" }}
            </button>
          </template>
          <template v-else>
            <button v-if="!isOwner" class="quiet danger-text" type="button" :disabled="saving" @click="leave">
              {{ t("group.leave") }}
            </button>
            <button v-else class="quiet danger-text" type="button" :disabled="saving" @click="destroy">
              {{ t("group.delete") }}
            </button>
            <button
              v-if="isOwner && agents.length"
              class="primary"
              type="button"
              data-testid="im-group-save"
              :disabled="saving"
              @click="saveAllowlists"
            >{{ t("group.save") }}</button>
          </template>
        </footer>
      </template>
    </section>
  </div>
</template>

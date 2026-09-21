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
import ContactPicker from "./ContactPicker.vue";

const props = defineProps<{
  session: ConnectSession;
  group?: IMGroup;
}>();

const emit = defineEmits<{
  close: [];
  created: [group: IMGroup];
  changed: [];
  removed: [group: IMGroup];
}>();

const title = ref("");
const selected = ref<Contact[]>([]);
const members = ref<GroupMember[]>([]);
const allowlists = ref<Record<number, AgentAllowlist>>({});
const allowlistDrafts = ref<Record<number, number[]>>({});
const loading = ref(false);
const saving = ref(false);
const error = ref("");

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
    error.value = cause instanceof Error ? cause.message : "Group details failed to load";
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
    error.value = cause instanceof Error ? cause.message : "Group creation failed";
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
    await load();
    emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Members could not be added";
  } finally {
    saving.value = false;
  }
}

async function removeMember(member: GroupMember): Promise<void> {
  if (!props.group || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    await removeGroupMember(props.group.id, member.uid, props.session);
    await load();
    emit("changed");
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Member could not be removed";
  } finally {
    saving.value = false;
  }
}

async function leave(): Promise<void> {
  if (!props.group || saving.value) return;
  if (!window.confirm(`Leave ${props.group.title}?`)) return;
  saving.value = true;
  try {
    await removeGroupMember(props.group.id, Number(props.session.uid), props.session);
    emit("removed", props.group);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Group could not be left";
  } finally {
    saving.value = false;
  }
}

async function destroy(): Promise<void> {
  if (!props.group || saving.value) return;
  if (!window.confirm(`Delete ${props.group.title}? This cannot be undone.`)) return;
  saving.value = true;
  try {
    await deleteGroup(props.group.id, props.session);
    emit("removed", props.group);
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Group could not be deleted";
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

async function saveAllowlist(agentUid: number): Promise<void> {
  if (!props.group || saving.value) return;
  saving.value = true;
  error.value = "";
  try {
    const allowlist = await replaceAgentAllowlist(
      props.group.id,
      agentUid,
      allowlistDrafts.value[agentUid] || [],
      props.session,
    );
    allowlists.value = { ...allowlists.value, [agentUid]: allowlist };
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : "Allowlist could not be saved";
  } finally {
    saving.value = false;
  }
}

function closeOnEscape(event: KeyboardEvent): void {
  if (event.key === "Escape") emit("close");
}

onMounted(() => window.addEventListener("keydown", closeOnEscape));
onBeforeUnmount(() => window.removeEventListener("keydown", closeOnEscape));
</script>

<template>
  <div class="dialog-backdrop" role="presentation" @mousedown.self="$emit('close')">
    <section class="group-dialog" role="dialog" aria-modal="true" :aria-label="group ? group.title : 'Create group'">
      <header class="dialog-header">
        <div>
          <h2>{{ group ? group.title : "Create group" }}</h2>
          <span v-if="group">{{ members.length }} members</span>
        </div>
        <button class="icon-button" type="button" aria-label="Close" title="Close" @click="$emit('close')">×</button>
      </header>

      <form v-if="!group" class="dialog-body form-stack" @submit.prevent="create">
        <label>
          Group title
          <input v-model="title" maxlength="255" required autofocus>
        </label>
        <ContactPicker
          v-model="selected"
          :session="session"
          multiple
          label="Members"
          placeholder="Search members"
          :exclude-uids="[Number(session.uid)]"
        />
        <p v-if="error" class="error" role="alert">{{ error }}</p>
        <button class="primary" type="submit" :disabled="saving || !title.trim()">
          {{ saving ? "Creating..." : "Create group" }}
        </button>
      </form>

      <div v-else class="dialog-body">
        <p v-if="loading" class="loading">Loading group...</p>
        <p v-if="error" class="error" role="alert">{{ error }}</p>

        <template v-if="!loading">
          <section class="group-section">
            <h3>Members</h3>
            <div class="member-list">
              <div v-for="member in members" :key="member.uid" class="member-row">
                <span>
                  <strong>{{ member.displayName || member.username }}</strong>
                  <small>
                    {{ member.accountType === "agent" ? "Agent" : `@${member.username}` }}
                    <template v-if="member.uid === group.creatorUid">, creator</template>
                  </small>
                </span>
                <button
                  v-if="isOwner && member.uid !== group.creatorUid"
                  class="quiet danger-text"
                  type="button"
                  :disabled="saving"
                  @click="removeMember(member)"
                >
                  Remove
                </button>
              </div>
            </div>
          </section>

          <section v-if="isOwner" class="group-section">
            <h3>Add members</h3>
            <ContactPicker
              v-model="selected"
              :session="session"
              multiple
              placeholder="Search contacts"
              :exclude-uids="members.map((member) => member.uid)"
            />
            <button class="quiet" type="button" :disabled="saving || !selected.length" @click="addMembers">
              Add selected
            </button>
          </section>

          <section v-if="isOwner && agents.length" class="group-section">
            <h3>Agent allowlists</h3>
            <div v-for="agent in agents" :key="agent.uid" class="allowlist">
              <div class="allowlist-heading">
                <strong>{{ agent.displayName || agent.username }}</strong>
                <span v-if="allowlists[agent.uid]?.ownerImplicit">Creator always allowed</span>
              </div>
              <label v-for="member in allowlistCandidates" :key="member.uid" class="check-row">
                <input
                  type="checkbox"
                  :checked="allowlistDrafts[agent.uid]?.includes(member.uid)"
                  @change="toggleAllowlist(agent.uid, member.uid)"
                >
                {{ member.displayName || member.username }}
              </label>
              <p v-if="!allowlistCandidates.length" class="picker-status">No other people in this group</p>
              <button class="quiet" type="button" :disabled="saving" @click="saveAllowlist(agent.uid)">
                Save allowlist
              </button>
            </div>
          </section>

          <footer class="dialog-actions">
            <button v-if="!isOwner" class="quiet danger-text" type="button" :disabled="saving" @click="leave">
              Leave group
            </button>
            <button v-else class="quiet danger-text" type="button" :disabled="saving" @click="destroy">
              Delete group
            </button>
          </footer>
        </template>
      </div>
    </section>
  </div>
</template>

import { ChannelTypeGroup, Mention, MessageText } from "wukongimjssdk";
import type { GroupMember } from "./api";

export function buildTextContent(text: string, mentionedUids: string[] = []): MessageText {
  const content = new MessageText(text);
  const uids = [...new Set(mentionedUids.filter(Boolean))];
  if (uids.length) {
    const mention = new Mention();
    mention.uids = uids;
    content.mention = mention;
  }
  return content;
}

/**
 * IM-FIX-1: people ride the same `mention.uids` as agents. The server only dispatches
 * agent accounts (webhook resolveAgentTargets), so a mentioned person never starts a task.
 */
export function buildOutgoingText(
  text: string,
  channelType: number,
  mentionedUids: string[],
  mentionedPersonUids: string[] = [],
): MessageText {
  return buildTextContent(text, channelType === ChannelTypeGroup ? [...mentionedUids, ...mentionedPersonUids] : []);
}

/** Who `@query` can address: the open group's members (never anyone else), minus the viewer, agents first. */
export function mentionCandidates(members: GroupMember[], selfUid: string, query: string): GroupMember[] {
  return members
    .filter((member) => String(member.uid) !== selfUid
      && `${member.displayName} ${member.username}`.toLocaleLowerCase().includes(query))
    .sort((a, b) => Number(b.accountType === "agent") - Number(a.accountType === "agent"));
}

/** Explicit uids only: @all is out of scope (and the SDK's cached isMentionMe never resets). */
export function mentionsMe(content: { mention?: Mention } | undefined, uid: string): boolean {
  return !!uid && !!content?.mention?.uids?.includes(uid);
}

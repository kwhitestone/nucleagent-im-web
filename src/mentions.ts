import { ChannelTypeGroup, Mention, MessageText } from "wukongimjssdk";

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

export function buildOutgoingText(
  text: string,
  channelType: number,
  mentionedUids: string[],
): MessageText {
  return buildTextContent(text, channelType === ChannelTypeGroup ? mentionedUids : []);
}

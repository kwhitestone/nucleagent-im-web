export interface StreamUpdate {
  key: string;
  text: string;
  done: boolean;
}

export function parseStreamEvent(type: string, data: Record<string, any>, current = ""): StreamUpdate | null {
  const payload = data.payload || data;
  const key = String(
    data.client_msg_no || data.clientMsgNo || data.stream_no || data.streamNo || data.id || "stream",
  );
  const chunk = String(payload.delta || payload.content || payload.text || "");

  if (type === "___TextMessageStart" || type === "stream.start") {
    return { key, text: chunk, done: false };
  }
  if (type === "___TextMessageContent" || type === "stream.delta") {
    return { key, text: current + chunk, done: false };
  }
  if (["___TextMessageEnd", "stream.close", "stream.finish", "stream.error", "stream.cancel"].includes(type)) {
    const snapshot = payload.snapshot?.text;
    return { key, text: snapshot ? String(snapshot) : current + chunk, done: true };
  }
  return null;
}

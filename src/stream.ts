export interface StreamUpdate {
  key: string;
  text: string;
  done: boolean;
}

export interface SSEMessage {
  id: string;
  event: string;
  data: string;
}

export type AgentStreamEvent =
  | {
    id: string;
    type: "open";
    sourceKey: string;
    agentUid: string;
  }
  | {
    id: string;
    type: "snapshot" | "complete";
    sourceKey: string;
    text: string;
    revision: number;
    clientMsgNo?: string;
  }
  | {
    id: string;
    type: "error";
    sourceKey: string;
    code: string;
  };

export interface LiveAgentResponse {
  sourceKey: string;
  agentUid: string;
  text: string;
  revision: number;
  status: "busy" | "complete" | "error";
  clientMsgNo?: string;
}

interface ConnectAgentStreamOptions {
  channelId: string;
  channelType: number;
  jwt: string;
  signal: AbortSignal;
  onEvent: (event: AgentStreamEvent) => void;
  onConnectionChange?: (state: "connected" | "reconnecting") => void;
  fetcher?: typeof fetch;
  retryDelay?: (signal: AbortSignal) => Promise<void>;
  baseUrl: string;
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

export function parseSSEBlock(block: string): SSEMessage | null {
  let id = "";
  let event = "message";
  const data: string[] = [];
  for (const line of block.replace(/\r/g, "").split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    const value = separator === -1 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = value;
    else if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  return data.length ? { id, event, data: data.join("\n") } : null;
}

export function parseAgentStreamEvent(message: SSEMessage): AgentStreamEvent | null {
  if (!["open", "snapshot", "complete", "error"].includes(message.event)) return null;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(message.data) as Record<string, unknown>;
  } catch {
    return null;
  }
  const sourceKey = String(data.sourceKey || "");
  if (!sourceKey) return null;
  if (message.event === "open") {
    return {
      id: message.id,
      type: "open",
      sourceKey,
      agentUid: String(data.agentUid || ""),
    };
  }
  if (message.event === "error") {
    return {
      id: message.id,
      type: "error",
      sourceKey,
      code: String(data.code || "agent_response_failed"),
    };
  }
  return {
    id: message.id,
    type: message.event as "snapshot" | "complete",
    sourceKey,
    text: String(data.text || ""),
    revision: Number(data.revision || 0),
    ...(message.event === "complete" ? { clientMsgNo: String(data.clientMsgNo || "") } : {}),
  };
}

export function applyAgentStreamEvent(
  current: LiveAgentResponse[],
  event: AgentStreamEvent,
): LiveAgentResponse[] {
  const existing = current.find((response) => response.sourceKey === event.sourceKey);
  if (event.type === "open") {
    if (existing) return current;
    return [...current, {
      sourceKey: event.sourceKey,
      agentUid: event.agentUid,
      text: "",
      revision: 0,
      status: "busy",
    }];
  }
  const base = existing || {
    sourceKey: event.sourceKey,
    agentUid: "",
    text: "",
    revision: 0,
    status: "busy" as const,
  };
  if ("revision" in event && event.revision < base.revision) return current;
  const next: LiveAgentResponse = event.type === "error"
    ? { ...base, status: "error" }
    : {
      ...base,
      text: event.text,
      revision: event.revision,
      status: event.type === "complete" ? "complete" : "busy",
      ...(event.clientMsgNo ? { clientMsgNo: event.clientMsgNo } : {}),
    };
  return [...current.filter((response) => response.sourceKey !== event.sourceKey), next];
}

export function reconcileLiveResponses(
  current: LiveAgentResponse[],
  durableClientMsgNos: Iterable<string>,
): LiveAgentResponse[] {
  const durable = new Set(durableClientMsgNos);
  return current.filter((response) => !response.clientMsgNo || !durable.has(response.clientMsgNo));
}

export function browserStreamChannelId(channelId: string, channelType: number, selfUid: string): string {
  if (channelType !== 1 || channelId.includes("@")) return channelId;
  return [Number(selfUid), Number(channelId)].sort((left, right) => left - right).join("@");
}

async function readSSE(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onMessage: (message: SSEMessage) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary !== -1) {
        const message = parseSSEBlock(buffer.slice(0, boundary));
        buffer = buffer.slice(boundary + 2);
        if (message) onMessage(message);
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function waitToReconnect(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = window.setTimeout(resolve, 750);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export async function connectAgentStream(options: ConnectAgentStreamOptions): Promise<void> {
  const fetcher = options.fetcher || fetch;
  const retryDelay = options.retryDelay || waitToReconnect;
  let lastEventId = "";
  while (!options.signal.aborted) {
    try {
      const params = new URLSearchParams({
        channel_id: options.channelId,
        channel_type: String(options.channelType),
      });
      const response = await fetcher(`${options.baseUrl}/api/v1/im/agent-streams?${params}`, {
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${options.jwt}`,
          ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
        },
        signal: options.signal,
      });
      if (!response.ok || !response.body) throw new Error(`Agent stream failed (${response.status})`);
      options.onConnectionChange?.("connected");
      await readSSE(response.body, options.signal, (message) => {
        if (message.id) lastEventId = message.id;
        const event = parseAgentStreamEvent(message);
        if (event) options.onEvent(event);
      });
    } catch (error) {
      if (options.signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return;
    }
    if (!options.signal.aborted) {
      options.onConnectionChange?.("reconnecting");
      await retryDelay(options.signal);
    }
  }
}

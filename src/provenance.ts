/**
 * Agent-to-agent provenance (M3).
 *
 * nucleagent-im stamps an `a2a` object onto every durable agent message payload.
 * The SDK keeps the decoded payload on `content.contentObj`, so the chain is
 * readable without touching the wire format or the SDK.
 */
export interface Provenance {
  chainId: string;
  /** 1 for a human-triggered answer, +1 per agent hop. */
  depth: number;
  originUid: string;
  /** The agent that triggered this message; empty when a human did. */
  viaUid: string;
}

/** 429-domain rejections the webhook returns for A2A guard hits. */
export const a2aRejectionCopy: Record<string, string> = {
  a2a_depth_exceeded: "Agent hand-off stopped: the chain reached its depth limit.",
  a2a_budget_exceeded: "Agent hand-off stopped: this chain reached its hourly message budget.",
  im_agent_rate_limited: "Too many requests to this agent. Please wait a moment.",
};

export function readProvenance(content: unknown): Provenance | null {
  const payload = (content as { contentObj?: Record<string, unknown> } | undefined)?.contentObj;
  const a2a = payload?.a2a as Record<string, unknown> | undefined;
  if (!a2a) return null;
  const chainId = String(a2a.chainId || "");
  if (!chainId) return null;
  return {
    chainId,
    depth: Number(a2a.depth || 0),
    originUid: String(a2a.originUid || ""),
    viaUid: String(a2a.viaUid || ""),
  };
}

/** True when this message answers another agent rather than a human. */
export function isAgentRelayed(provenance: Provenance | null): boolean {
  return Boolean(provenance && provenance.depth > 1 && provenance.viaUid);
}

export function rejectionCopy(code: string): string {
  return a2aRejectionCopy[code] || "The agent could not complete this request.";
}

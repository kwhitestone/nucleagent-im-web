// UNI-IM-REDESIGN: the agents a user can DM in IM (im GET /api/v1/im/agents) —
// active definitions with an IM identity. Tapping one opens a normal direct
// channel; O-2 routing answers it from the sender's own instance.
import { imBase, type ConnectSession } from "./api.ts";

export interface DirectoryAgent {
  uid: number;
  name: string;
  description: string;
  avatar?: string;
  revision?: string;
  effectiveSource?: string;
  modelRule?: string;
  promptRule?: string;
  overrideRule?: string;
  inFlightRule?: string;
}

export class AgentDirectory {
  agents: DirectoryAgent[] = [];
  revision = "";
  private generation = 0;
  private fetcher: typeof fetch;
  constructor(fetcher: typeof fetch = fetch) { this.fetcher = fetcher; }
  clear(): void { this.generation++; this.agents = []; this.revision = ""; }
  private async request(session: ConnectSession, suffix = "") {
    const fetcher = this.fetcher;
    const response = await fetcher(`${imBase}/api/v1/im/agents${suffix}`, {
      headers: { Authorization: session.jwt }, cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Agent directory ${response.status}`);
    const body = await response.json();
    if (body?.code !== 0) throw new Error("Invalid agent directory");
    return { data: body.data, revision: response.headers.get("X-IM-Directory-Revision") };
  }
  async refresh(session: ConnectSession): Promise<void> {
    const generation = ++this.generation;
    try {
      const result = await this.request(session);
      if (generation !== this.generation) return;
      if (!Array.isArray(result.data) || !result.revision) throw new Error("Invalid agent directory");
      const seen = new Set<number>();
      const agents: DirectoryAgent[] = result.data.map((agent: DirectoryAgent) => {
        if (!agent || !Number.isSafeInteger(agent.uid) || agent.uid <= 0 || seen.has(agent.uid)
          || typeof agent.name !== "string" || typeof agent.description !== "string"
          || ["avatar", "revision", "effectiveSource", "modelRule", "promptRule", "overrideRule", "inFlightRule"]
            .some(key => agent[key as keyof DirectoryAgent] !== undefined && typeof agent[key as keyof DirectoryAgent] !== "string")) {
          throw new Error("Invalid agent directory");
        }
        seen.add(agent.uid);
        return { uid: agent.uid, name: agent.name, description: agent.description,
          ...Object.fromEntries(["avatar", "revision", "effectiveSource", "modelRule", "promptRule", "overrideRule", "inFlightRule"]
            .filter(key => agent[key as keyof DirectoryAgent] !== undefined).map(key => [key, agent[key as keyof DirectoryAgent]])) };
      });
      this.agents = agents; this.revision = result.revision;
    } catch (error) {
      if (generation === this.generation) { this.agents = []; this.revision = ""; }
      throw error;
    }
  }
  async poll(session: ConnectSession): Promise<boolean> {
    if (!this.revision) { await this.refresh(session); return true; }
    const generation = this.generation;
    try {
      const result = await this.request(session, `/events?${new URLSearchParams({ after: this.revision })}`);
      if (generation !== this.generation) return false;
      if (typeof result.data?.changed !== "boolean" || typeof result.data.revision !== "string") throw new Error("Invalid directory event");
      if (result.data.changed || result.data.revision !== this.revision) { await this.refresh(session); return true; }
      return false;
    } catch (error) {
      if (generation === this.generation) this.clear();
      throw error;
    }
  }
}

export async function listAgents(session: ConnectSession): Promise<DirectoryAgent[]> {
  const directory = new AgentDirectory();
  await directory.refresh(session);
  return directory.agents;
}

/** Search: name, resolved nickName or description contains the query (case-insensitive). */
export function matchAgents(agents: DirectoryAgent[], query: string, nameOf: (uid: string) => string = () => ""): DirectoryAgent[] {
  const q = query.trim().toLocaleLowerCase();
  if (q.length < 2) return [];
  return agents.filter((agent) =>
    `${agent.name}\n${nameOf(String(agent.uid))}\n${agent.description}`.toLocaleLowerCase().includes(q));
}

/** The Agents tab lists conversations first; these are the directory agents with none yet, by name. */
export function uncontactedAgents(agents: DirectoryAgent[], conversationUids: Iterable<string>): DirectoryAgent[] {
  const seen = new Set(conversationUids);
  return agents.filter((agent) => !seen.has(String(agent.uid))).sort((a, b) => a.name.localeCompare(b.name));
}

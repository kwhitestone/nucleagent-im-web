// UNI-IM-REDESIGN: the agents a user can DM in IM (im GET /api/v1/im/agents) —
// active definitions with an IM identity. Tapping one opens a normal direct
// channel; O-2 routing answers it from the sender's own instance.
import { imBase, type ConnectSession } from "./api.ts";

export interface DirectoryAgent {
  uid: number;
  name: string;
  description: string;
}

/** Fetched once per session. Any failure (older im without the route, network) is an empty directory, never an error. */
export async function listAgents(session: ConnectSession): Promise<DirectoryAgent[]> {
  try {
    const response = await fetch(`${imBase}/api/v1/im/agents`, { headers: { Authorization: session.jwt } });
    const body = await response.json() as { code?: number; data?: DirectoryAgent[] };
    return response.ok && body.code === 0 && Array.isArray(body.data) ? body.data : [];
  } catch {
    return [];
  }
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

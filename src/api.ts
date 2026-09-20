const authBase = trimBase(import.meta.env.VITE_AUTH_BASE || "http://127.0.0.1:26670");
export const imBase = trimBase(import.meta.env.VITE_IM_BASE || "http://127.0.0.1:26655");

export interface ConnectSession {
  uid: string;
  token: string;
  wsAddr: string;
  jwt: string;
}

interface Envelope<T> {
  code: number;
  message: string;
  data: T;
}

interface LoginData {
  accessToken: string;
}

interface ConnectData {
  uid: string;
  token: string;
  wsAddr: string;
}

function trimBase(value: string): string {
  return value.replace(/\/+$/, "");
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Server returned invalid JSON (${response.status})`);
  }
}

async function readEnvelope<T>(response: Response): Promise<T> {
  const body = await readJson(response) as Partial<Envelope<T>>;
  if (!response.ok || body.code !== 0 || body.data === undefined) {
    throw new Error(body.message || `Request failed (${response.status})`);
  }
  return body.data;
}

export async function createSession(username: string, password: string): Promise<ConnectSession> {
  const loginResponse = await fetch(`${authBase}/api/v1/addons/auth/login`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      "X-Refresh-Cookie-Only": "1",
    },
    body: JSON.stringify({ username, password }),
  });
  const login = await readEnvelope<LoginData>(loginResponse);
  if (!login.accessToken) throw new Error("Auth response did not include accessToken");

  const connectResponse = await fetch(`${imBase}/api/v1/im/connect-token`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${login.accessToken}`,
    },
  });
  const connect = await readEnvelope<ConnectData>(connectResponse);
  if (!connect.uid || !connect.token || !connect.wsAddr) {
    throw new Error("IM response must include uid, token, and wsAddr");
  }
  return { ...connect, jwt: login.accessToken };
}

export async function postIM<T>(
  path: string,
  body: Record<string, unknown>,
  session: ConnectSession,
): Promise<T> {
  const response = await fetch(`${imBase}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${session.jwt}`,
      "Content-Type": "application/json",
      token: session.token,
    },
    body: JSON.stringify({
      ...body,
      uid: session.uid,
      login_uid: session.uid,
    }),
  });
  const data = await readJson(response) as T | Envelope<T>;
  if (!response.ok) {
    throw new Error((data as Partial<Envelope<T>>).message || `IM request failed (${response.status})`);
  }
  if (typeof data === "object" && data !== null && "code" in data && "data" in data) {
    const envelope = data as Envelope<T>;
    if (envelope.code !== 0) throw new Error(envelope.message || "IM request failed");
    return envelope.data;
  }
  return data as T;
}

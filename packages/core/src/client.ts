import type { AgentType, BusEvent, Session, SessionSummary } from "./types.ts";

export type ApiMessage = {
  role: string;
  content: unknown;
  [key: string]: unknown;
};

export type EventSourceLike = {
  close: () => void;
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type ClientConfig = {
  baseUrl?: string;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  password?: string;
  eventSource?: (url: string) => EventSourceLike;
};

export type RalphboxClient = {
  baseUrl: string;
  health: () => Promise<{ healthy: boolean }>;
  sessions: {
    list: () => Promise<SessionSummary[]>;
    get: (id: string) => Promise<Session>;
    create: (agent: AgentType) => Promise<Session>;
    run: (id: string, input: { agent: AgentType; messages: ApiMessage[] }) => Promise<Response>;
  };
  events: {
    connect: () => EventSourceLike;
  };
};

export function normalizeServerUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "http://localhost:8642";
  const withProtocol = /^https?:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withProtocol.replace(/\/+$/, "");
}

function encodeBase64(value: string): string {
  if (typeof btoa !== "undefined") {
    return btoa(unescape(encodeURIComponent(value)));
  }
  return Buffer.from(value, "utf-8").toString("base64");
}

function buildAuthHeaders(password: string | undefined, headers?: Record<string, string>) {
  if (!password) return headers;
  return {
    ...headers,
    Authorization: `Basic ${encodeBase64(`ralphbox:${password}`)}`,
  };
}

function withToken(url: string, password: string | undefined): string {
  if (!password) return url;
  const next = new URL(url);
  next.searchParams.set("token", password);
  return next.toString();
}

export function createRalphboxClient(config?: ClientConfig): RalphboxClient {
  const baseUrl = normalizeServerUrl(config?.baseUrl ?? "http://localhost:8642");
  const fetchFn = config?.fetch ?? fetch;
  const authHeaders = buildAuthHeaders(config?.password, config?.headers);
  const readJson = async <T>(res: Response): Promise<T> => {
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) {
      const error = new Error(`Request failed with status ${res.status}`);
      (error as { status?: number; data?: unknown }).status = res.status;
      (error as { status?: number; data?: unknown }).data = data;
      throw error;
    }
    return data;
  };

  return {
    baseUrl,
    async health() {
      const res = await fetchFn(`${baseUrl}/api/health`, { headers: authHeaders });
      return await readJson<{ healthy: boolean }>(res);
    },
    sessions: {
      async list() {
        const res = await fetchFn(`${baseUrl}/api/sessions`, { headers: authHeaders });
        return await readJson<SessionSummary[]>(res);
      },
      async get(id: string) {
        const res = await fetchFn(`${baseUrl}/api/sessions/${id}`, { headers: authHeaders });
        return await readJson<Session>(res);
      },
      async create(agent: AgentType) {
        const res = await fetchFn(`${baseUrl}/api/sessions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify({ agent }),
        });
        return await readJson<Session>(res);
      },
      async run(id: string, input: { agent: AgentType; messages: ApiMessage[] }) {
        return await fetchFn(`${baseUrl}/api/sessions/${id}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders },
          body: JSON.stringify(input),
        });
      },
    },
    events: {
      connect() {
        const factory =
          config?.eventSource ??
          ((url: string) => {
            const EventSourceConstructor = (
              globalThis as unknown as { EventSource?: new (url: string) => EventSourceLike }
            ).EventSource;
            if (!EventSourceConstructor) {
              throw new Error("EventSource is not available in this environment");
            }
            return new EventSourceConstructor(url);
          });
        return factory(withToken(`${baseUrl}/events`, config?.password));
      },
    },
  };
}

export type { BusEvent };

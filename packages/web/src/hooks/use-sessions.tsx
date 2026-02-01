import type {
  BusEvent,
  MessagePart,
  Session,
  SessionSummary,
  UIMessage,
} from "@ralphbox/core/types";
import {
  createRalphboxClient,
  normalizeServerUrl,
  type RalphboxClient,
} from "@ralphbox/core/client";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "react-router-dom";

const DEFAULT_API_URL = ((import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_RALPHBOX_SERVER_URL ?? "http://localhost:8642") as string;
const DEFAULT_PASSWORD = (import.meta as unknown as { env?: Record<string, string> }).env
  ?.VITE_RALPHBOX_SERVER_PASSWORD;

function getApiUrl(): string {
  if (typeof window === "undefined") return DEFAULT_API_URL;
  const stored = window.localStorage.getItem("ralphbox.serverUrl");
  return stored ?? DEFAULT_API_URL;
}

type EventCallback = (event: BusEvent) => void;

type SessionsContextValue = {
  sessions: SessionSummary[];
  subscribe: (callback: EventCallback) => () => void;
  client: RalphboxClient;
};

const SessionsContext = createContext<SessionsContextValue | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }): ReactNode {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const listenersRef = useRef<Set<EventCallback>>(new Set());
  const serverUrl = useMemo(() => normalizeServerUrl(getApiUrl()), []);
  const client = useMemo(
    () => createRalphboxClient({ baseUrl: serverUrl, password: DEFAULT_PASSWORD }),
    [serverUrl],
  );

  async function refreshSessions(): Promise<void> {
    try {
      const data = await client.sessions.list();
      setSessions(data);
    } catch {
      setSessions([]);
    }
  }

  function subscribe(callback: EventCallback): () => void {
    listenersRef.current.add(callback);
    return () => listenersRef.current.delete(callback);
  }

  useEffect(() => {
    refreshSessions();
  }, []);

  useEffect(() => {
    const eventSource = client.events.connect();

    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data) as BusEvent;

      if (event.type === "session.created" || event.type === "session.updated") {
        refreshSessions();
      }

      for (const listener of listenersRef.current) {
        listener(event);
      }
    };

    eventSource.onerror = () => {
      // Keep existing sessions list; SSE will auto-reconnect
    };

    return () => eventSource.close();
  }, [client]);

  return (
    <SessionsContext.Provider value={{ sessions, subscribe, client }}>
      {children}
    </SessionsContext.Provider>
  );
}

export function useSessions(): SessionsContextValue {
  const ctx = useContext(SessionsContext);
  if (!ctx) throw new Error("useSessions must be used within SessionsProvider");
  return ctx;
}

type StatusMessage = {
  type: "sandbox" | "info";
  text: string;
  timestamp: number;
};

export function useSessionStatus(sessionId: string | undefined): StatusMessage | null {
  const { subscribe } = useSessions();
  const [status, setStatus] = useState<StatusMessage | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setStatus(null);
      return;
    }

    return subscribe((event) => {
      if (event.type === "session.chunk" && event.properties.sessionId === sessionId) {
        const chunk = event.properties.chunk;

        if (chunk.type === "data-sandbox" && typeof chunk.data?.text === "string") {
          setStatus({ type: "sandbox", text: chunk.data.text, timestamp: Date.now() });
        }
      }

      if (event.type === "session.updated" && event.properties.sessionId === sessionId) {
        setStatus(null);
      }
    });
  }, [sessionId, subscribe]);

  return status;
}

export function useSession(): Session | null {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { subscribe, client } = useSessions();
  const [session, setSession] = useState<Session | null>(null);
  const partsRef = useRef<Map<string, MessagePart>>(new Map());
  const messagesRef = useRef<Map<string, UIMessage>>(new Map());

  const rebuildSession = useCallback((base: Omit<Session, "messages"> | null): Session | null => {
    if (!base) return null;

    const messages: UIMessage[] = [];
    for (const msg of messagesRef.current.values()) {
      const parts = Array.from(partsRef.current.values())
        .filter((p) => p.messageId === msg.id)
        .sort((a, b) => {
          const orderA = a.order ?? 0;
          const orderB = b.order ?? 0;
          if (orderA !== orderB) return orderA - orderB;
          const timeA = a.createdAt ?? 0;
          const timeB = b.createdAt ?? 0;
          if (timeA !== timeB) return timeA - timeB;
          return a.id.localeCompare(b.id);
        });
      messages.push({ ...msg, parts });
    }

    messages.sort((a, b) => {
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      const timeA = a.createdAt ?? 0;
      const timeB = b.createdAt ?? 0;
      if (timeA !== timeB) return timeA - timeB;
      return a.id.localeCompare(b.id);
    });

    return { ...base, messages };
  }, []);

  useEffect(() => {
    const activeSessionId = sessionId;
    if (!activeSessionId) {
      setSession(null);
      partsRef.current.clear();
      messagesRef.current.clear();
      return;
    }

    async function fetchSession(id: string): Promise<void> {
      try {
        const data = await client.sessions.get(id);
        partsRef.current.clear();
        messagesRef.current.clear();

        for (const msg of data.messages) {
          messagesRef.current.set(msg.id, msg);
          for (const part of msg.parts) {
            partsRef.current.set(part.id, part);
          }
        }

        setSession(data);
      } catch {
        setSession(null);
      }
    }

    fetchSession(activeSessionId);

    return subscribe((event) => {
      if (event.type === "message.created" && event.properties.sessionId === activeSessionId) {
        const { message } = event.properties;
        messagesRef.current.set(message.id, message);
        setSession((prev) => rebuildSession(prev));
        return;
      }

      if (event.type === "part.updated" && event.properties.sessionId === activeSessionId) {
        const { part, delta } = event.properties;
        const existing = partsRef.current.get(part.id);

        if (delta && existing && (existing.type === "text" || existing.type === "reasoning")) {
          partsRef.current.set(part.id, {
            ...existing,
            text: existing.text + delta,
          });
        } else {
          partsRef.current.set(part.id, part);
        }

        setSession((prev) => rebuildSession(prev));
        return;
      }

      if (event.type === "session.updated" && event.properties.sessionId === activeSessionId) {
        fetchSession(activeSessionId);
      }
    });
  }, [sessionId, subscribe, rebuildSession]);

  return session;
}

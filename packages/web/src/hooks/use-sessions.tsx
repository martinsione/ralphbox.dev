import type {
  BusEvent,
  MessagePart,
  Session,
  SessionSummary,
  UIMessage,
} from "@ralphbox/core/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useParams } from "react-router-dom";

const API_URL = "http://localhost:8642";

type EventCallback = (event: BusEvent) => void;

type SessionsContextValue = {
  sessions: SessionSummary[];
  subscribe: (callback: EventCallback) => () => void;
};

const SessionsContext = createContext<SessionsContextValue | null>(null);

export function SessionsProvider({ children }: { children: ReactNode }): ReactNode {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const listenersRef = useRef<Set<EventCallback>>(new Set());

  async function refreshSessions(): Promise<void> {
    const res = await fetch(`${API_URL}/api/sessions`);
    setSessions((await res.json()) as SessionSummary[]);
  }

  function subscribe(callback: EventCallback): () => void {
    listenersRef.current.add(callback);
    return () => listenersRef.current.delete(callback);
  }

  useEffect(() => {
    refreshSessions();
  }, []);

  useEffect(() => {
    const eventSource = new EventSource(`${API_URL}/events`);

    eventSource.onmessage = (e) => {
      const event = JSON.parse(e.data) as BusEvent;

      if (event.type === "session.created" || event.type === "session.updated") {
        refreshSessions();
      }

      for (const listener of listenersRef.current) {
        listener(event);
      }
    };

    return () => eventSource.close();
  }, []);

  return (
    <SessionsContext.Provider value={{ sessions, subscribe }}>{children}</SessionsContext.Provider>
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
  const { subscribe } = useSessions();
  const [session, setSession] = useState<Session | null>(null);
  const partsRef = useRef<Map<string, MessagePart>>(new Map());
  const messagesRef = useRef<Map<string, UIMessage>>(new Map());

  const rebuildSession = useCallback((base: Omit<Session, "messages"> | null): Session | null => {
    if (!base) return null;

    const messages: UIMessage[] = [];
    for (const msg of messagesRef.current.values()) {
      const parts = Array.from(partsRef.current.values()).filter((p) => p.messageId === msg.id);
      messages.push({ ...msg, parts });
    }

    return { ...base, messages };
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      partsRef.current.clear();
      messagesRef.current.clear();
      return;
    }

    async function fetchSession(): Promise<void> {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}`);
      const data = (await res.json()) as Session;

      partsRef.current.clear();
      messagesRef.current.clear();

      for (const msg of data.messages) {
        messagesRef.current.set(msg.id, msg);
        for (const part of msg.parts) {
          partsRef.current.set(part.id, part);
        }
      }

      setSession(data);
    }

    fetchSession();

    return subscribe((event) => {
      if (event.type === "message.created" && event.properties.sessionId === sessionId) {
        const { message } = event.properties;
        messagesRef.current.set(message.id, message);
        setSession((prev) => rebuildSession(prev));
        return;
      }

      if (event.type === "part.updated" && event.properties.sessionId === sessionId) {
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

      if (event.type === "session.updated" && event.properties.sessionId === sessionId) {
        fetchSession();
      }
    });
  }, [sessionId, subscribe, rebuildSession]);

  return session;
}

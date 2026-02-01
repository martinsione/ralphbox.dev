import type { BusEvent, Session, SessionSummary } from "@ralphbox/core/types";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
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

export function useSession(): Session | null {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { subscribe } = useSessions();
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setSession(null);
      return;
    }

    async function fetchSession(): Promise<void> {
      const res = await fetch(`${API_URL}/api/sessions/${sessionId}`);
      setSession((await res.json()) as Session);
    }

    fetchSession();

    return subscribe((event) => {
      if (
        (event.type === "session.updated" || event.type === "session.chunk") &&
        event.properties.sessionId === sessionId
      ) {
        fetchSession();
      }
    });
  }, [sessionId, subscribe]);

  return session;
}

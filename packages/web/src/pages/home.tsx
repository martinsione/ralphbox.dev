import type { Session, SessionSummary } from "@ralphbox/core/types";
import { useEffect, useState } from "react";

const API_URL = "http://localhost:8642";

export function Home() {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selected, setSelected] = useState<Session | null>(null);

  useEffect(() => {
    fetch(`${API_URL}/api/sessions`)
      .then((r) => r.json())
      .then(setSessions);
  }, []);

  const loadSession = async (id: string) => {
    const res = await fetch(`${API_URL}/api/sessions/${id}`);
    const session = await res.json();
    setSelected(session);
  };

  return (
    <div className="flex h-screen">
      <div className="w-64 overflow-auto border-r p-4">
        <h2 className="mb-4 font-bold">Sessions</h2>
        {sessions.map((s) => (
          <div
            key={s.id}
            onClick={() => loadSession(s.id)}
            className={`mb-1 cursor-pointer rounded p-2 ${
              selected?.id === s.id ? "bg-blue-100" : "hover:bg-gray-100"
            }`}
          >
            <div className="truncate font-mono text-sm">{s.id}</div>
            <div className="text-xs text-gray-500">
              {s.status} · {s.agent}
            </div>
          </div>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {selected ? (
          <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(selected, null, 2)}</pre>
        ) : (
          <div className="text-gray-500">Select a session</div>
        )}
      </div>
    </div>
  );
}

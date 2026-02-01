import { Link, useParams } from "react-router-dom";
import { useSession, useSessions } from "@/hooks/use-sessions";
import { cn } from "@/lib/utils";

export function Home() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const { sessions } = useSessions();
  const session = useSession();

  return (
    <div className="flex h-screen">
      <div className="w-64 overflow-auto border-r p-4">
        <h2 className="mb-4 font-bold">Sessions</h2>
        {sessions.map((s) => (
          <Link
            key={s.id}
            to={`/s/${s.id}`}
            className={cn(
              "mb-1 block cursor-pointer rounded p-2",
              sessionId === s.id ? "bg-blue-100" : "hover:bg-gray-100",
            )}
          >
            <div className="truncate font-mono text-sm">{s.id}</div>
            <div className="text-xs text-gray-500">
              {s.status} · {s.agent}
            </div>
          </Link>
        ))}
      </div>
      <div className="flex-1 overflow-auto p-4">
        {session ? (
          <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(session, null, 2)}</pre>
        ) : (
          <div className="text-gray-500">Select a session</div>
        )}
      </div>
    </div>
  );
}
